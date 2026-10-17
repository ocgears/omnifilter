import {
  Component,
  ElementRef,
  OnDestroy,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { GpuEngine, GpuImage, StackRenderer } from '../../gpu';
import { Layer } from '../models';
import { PreviewEngine, stackLayers } from './preview-engine';

// The longer side frames are filtered at.
const FRAME_SIZE = 960;

// The camera, with the filter stack applied to every frame on this device's
// GPU. The shutter takes the frame as it comes from the camera, so the
// server can then filter it at full size.
@Component({
  selector: 'of-live-camera',
  templateUrl: './live-camera.html',
  styleUrl: './live-camera.scss',
})
export class LiveCamera implements OnDestroy {
  private readonly engines = inject(PreviewEngine);

  readonly layers = input.required<Layer[]>();
  readonly blendModes = input<string[]>([]);
  // A photo from the camera, as a JPEG data URL.
  readonly captured = output<string>();
  readonly closed = output<void>();

  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('video');
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  readonly state = signal<'starting' | 'live' | 'failed'>('starting');
  readonly error = signal('');
  readonly facing = signal<'environment' | 'user'>('environment');
  readonly canFlip = signal(false);
  readonly frameMs = signal<number | null>(null);
  readonly stoppedAt = signal<string | null>(null);

  readonly status = computed(() => {
    if (this.state() === 'failed') return this.error();
    if (this.state() === 'starting') return 'Opening the camera…';
    const stopped = this.stoppedAt();
    if (stopped) return stopped;
    const ms = this.frameMs();
    return ms === null ? 'Live' : 'Live · ' + Math.max(1, Math.round(ms)) + ' ms a frame';
  });

  private stream: MediaStream | null = null;
  private engine: GpuEngine | null = null;
  private renderer: StackRenderer | null = null;
  private frame: GpuImage | null = null;
  private running = false;
  private stopped = false;
  private avgMs = 0;

  constructor() {
    queueMicrotask(() => this.start());
  }

  async start(): Promise<void> {
    this.stop();
    this.stopped = false;
    this.state.set('starting');
    try {
      const engine = this.engine ?? (await this.engines.get());
      if (!engine) throw new Error('Live camera filters need a browser with WebGPU.');
      if (this.engine !== engine) this.watch(engine);
      this.engine = engine;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: this.facing(),
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      // Closed while the camera was opening: turn it straight off again.
      if (this.stopped) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.stream = stream;
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.canFlip.set(devices.filter((d) => d.kind === 'videoinput').length > 1);
      const video = this.video().nativeElement;
      video.srcObject = this.stream;
      await video.play();
      if (this.stopped) return;
      this.renderer ??= new StackRenderer(engine, this.blendModes(), FRAME_SIZE);
      this.state.set('live');
      this.next();
    } catch (err) {
      this.state.set('failed');
      const name = (err as Error).name;
      this.error.set(
        name === 'NotAllowedError'
          ? "The camera is blocked. Allow it for this site in the browser's settings."
          : name === 'NotFoundError'
            ? 'No camera was found.'
            : (err as Error).message || 'Could not open the camera.',
      );
    }
  }

  // A lost GPU device takes the renderer's images with it: carry on with a
  // new engine, with the camera still open.
  private watch(engine: GpuEngine): void {
    engine.device.lost.then(async () => {
      if (this.engine !== engine) return;
      this.engine = null;
      this.renderer = null;
      this.frame = null;
      const next = await this.engines.get();
      if (this.engine || this.stopped) return;
      if (!next) {
        this.state.set('failed');
        this.error.set('The GPU stopped working. Close the camera and try again.');
        return;
      }
      this.watch(next);
      this.engine = next;
      this.renderer = new StackRenderer(next, this.blendModes(), FRAME_SIZE);
    });
  }

  // One filtered frame per new camera frame (or display frame, where the
  // browser can't say when the camera has one).
  private next(): void {
    if (this.stopped) return;
    const video = this.video().nativeElement as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => this.draw());
    else requestAnimationFrame(() => this.draw());
  }

  private async draw(): Promise<void> {
    const video = this.video().nativeElement;
    const engine = this.engine;
    const renderer = this.renderer;
    if (this.stopped || !engine || !renderer || this.running) return this.next();
    if (!video.videoWidth || !video.videoHeight) return this.next();
    this.running = true;
    const start = performance.now();
    try {
      const scale = Math.min(1, FRAME_SIZE / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      this.frame = engine.imageFromFrame(
        video,
        video.videoWidth,
        video.videoHeight,
        width,
        height,
        this.frame,
      );
      renderer.setBlendModes(this.blendModes());
      renderer.setSourceImage(this.frame);
      const layers = stackLayers(this.layers());
      // A filter used for the first time is compiled in the background.
      const kernels = renderer.kernelsFor(layers);
      if (!engine.hasPipelines(kernels)) await engine.preparePipelines(kernels);
      let result = renderer.render(layers);
      if ('unsupported' in result) {
        this.stoppedAt.set(
          'Live, without layer ' + (result.unsupported + 1) + ', which ' + result.reason + '.',
        );
        result = renderer.render(layers.slice(0, result.unsupported));
      } else {
        this.stoppedAt.set(null);
      }
      if ('image' in result) engine.present(result.image, this.canvas().nativeElement);
      await engine.done();
      const refused = engine.takeError();
      if (refused) {
        console.error('Live camera:', refused.message);
        this.stoppedAt.set("The GPU couldn't run these filters on the camera's frames.");
      }
      const ms = performance.now() - start;
      this.avgMs = this.avgMs ? this.avgMs * 0.9 + ms * 0.1 : ms;
      this.frameMs.set(this.avgMs);
    } catch (err) {
      console.error('Live camera:', err);
    } finally {
      this.running = false;
      this.next();
    }
  }

  // The camera's frame at full size, unfiltered, as a JPEG.
  capture(): void {
    const video = this.video().nativeElement;
    if (!video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    this.captured.emit(canvas.toDataURL('image/jpeg', 0.92));
  }

  flip(): void {
    this.facing.update((f) => (f === 'user' ? 'environment' : 'user'));
    this.start();
  }

  close(): void {
    this.stop();
    this.closed.emit();
  }

  private stop(): void {
    this.stopped = true;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }

  ngOnDestroy(): void {
    this.stop();
    // The renderer owns the frame image (it's the source), and the engine
    // keeps a texture the size of the camera's frames.
    this.renderer?.destroy();
    this.renderer = null;
    this.frame = null;
    this.engine?.releaseFrame();
  }
}
