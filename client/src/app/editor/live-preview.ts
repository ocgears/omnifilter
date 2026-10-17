import {
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { GpuEngine, StackRenderer } from '../../gpu';
import { Layer } from '../models';
import { PreviewEngine, decodePhoto, stackLayers } from './preview-engine';

// The longer side of the copy the preview filters: about what a phone or
// laptop screen shows, so filters run in milliseconds. The server always
// filters the full photo.
export const PREVIEW_SIZE = 1024;

type Mode = 'starting' | 'live' | 'static';

// The photo with the current filter stack applied live, on this device's
// GPU (WebGPU), using the same filter plans as the server. Press and hold
// to see the original. Where WebGPU isn't available it shows the photo as
// it is, and Transform shows the result.
@Component({
  selector: 'of-live-preview',
  templateUrl: './live-preview.html',
  styleUrl: './live-preview.scss',
})
export class LivePreview implements OnDestroy {
  private readonly engines = inject(PreviewEngine);

  // The photo, as a data URL.
  readonly source = input.required<string>();
  readonly layers = input.required<Layer[]>();
  // The blend mode names in the server's order (from GET /presets).
  readonly blendModes = input<string[]>([]);
  // Set while the photo is being filtered at full size on this GPU (in a
  // worker): the preview stops drawing and lets go of its intermediate
  // images, so the two don't compete for a phone GPU's time and memory.
  // Changes made meanwhile are drawn when it's unpaused.
  readonly paused = input(false);

  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  readonly mode = signal<Mode>('starting');
  readonly comparing = signal(false);
  // How long the last update took, in milliseconds.
  readonly renderMs = signal<number | null>(null);
  // The first layer the browser can't run (1-based), and why.
  readonly stoppedAt = signal<{ layer: number; reason: string } | null>(null);
  // Set when the last update failed (the stack still shows as it was).
  readonly failed = signal(false);
  readonly software = signal(false);

  readonly status = computed(() => {
    switch (this.mode()) {
      case 'starting':
        return 'Starting the live preview…';
      case 'static':
        return 'Live preview needs a browser with WebGPU. Transform shows the result.';
      default: {
        if (this.paused()) return 'Live preview paused while the full-size photo is made.';
        if (this.failed()) return "The preview couldn't show these settings. Transform still can.";
        const stopped = this.stoppedAt();
        if (stopped) {
          return (
            'The preview shows the filters above layer ' +
            stopped.layer +
            ', which ' +
            stopped.reason +
            '. Transform shows the full result.'
          );
        }
        const ms = this.renderMs();
        const where = this.software()
          ? 'Live preview (software GPU)'
          : "Live preview on this device's GPU";
        return ms === null ? where : where + ' · ' + Math.max(1, Math.round(ms)) + ' ms';
      }
    }
  });

  private engine: GpuEngine | null = null;
  private renderer: StackRenderer | null = null;
  private loading = 0;
  private dirty = false;
  private running = false;
  private destroyed = false;

  constructor() {
    effect(() => {
      const src = this.source();
      this.load(src);
    });
    effect(() => {
      // Redraw whenever any of these change.
      this.layers();
      this.blendModes();
      this.comparing();
      if (!this.paused()) this.schedule();
    });
    effect(() => {
      if (this.paused()) {
        this.comparing.set(false);
        // Each layer's result is cached for the next change; drop them.
        if (!this.running) this.renderer?.clearCache();
      }
    });
  }

  private async load(src: string): Promise<void> {
    const token = ++this.loading;
    try {
      const engine = this.engine ?? (await this.engines.get());
      if (token !== this.loading || this.destroyed) return;
      if (!engine) {
        this.mode.set('static');
        return;
      }
      if (this.engine !== engine) this.watch(engine);
      this.engine = engine;
      this.software.set(engine.adapterInfo.fallback);
      this.failed.set(false);
      const photo = await decodePhoto(src, PREVIEW_SIZE);
      if (token !== this.loading || this.destroyed) return;
      if (!this.renderer) this.renderer = new StackRenderer(engine, this.blendModes());
      this.renderer.setSource(
        photo.rgba,
        photo.width,
        photo.height,
        photo.fullWidth,
        photo.fullHeight,
      );
      this.mode.set('live');
      this.schedule();
    } catch (err) {
      console.error('Live preview:', err);
      if (token === this.loading) this.mode.set('static');
    }
  }

  // A lost GPU device (a driver reset, or a phone reclaiming memory from a
  // background tab) takes the renderer's images with it: start again with a
  // new engine, as soon as it's lost rather than at the next change.
  private watch(engine: GpuEngine): void {
    engine.device.lost.then(() => {
      if (this.engine !== engine || this.destroyed) return;
      this.engine = null;
      this.renderer = null;
      this.load(this.source());
    });
  }

  // Draws at most once per frame; changes made while a frame is on the GPU
  // are drawn in the next one.
  private schedule(): void {
    this.dirty = true;
    if (!this.running) requestAnimationFrame(() => this.frame());
  }

  private async frame(): Promise<void> {
    const renderer = this.renderer;
    const engine = this.engine;
    if (!this.dirty || this.running || !renderer || !engine || this.destroyed) return;
    if (this.paused()) return;
    this.dirty = false;
    this.running = true;
    const start = performance.now();
    try {
      // The blend modes can arrive after the photo.
      renderer.setBlendModes(this.blendModes());
      const layers = stackLayers(this.layers());
      let result = renderer.render(layers);
      if ('unsupported' in result) {
        this.stoppedAt.set({ layer: result.unsupported + 1, reason: result.reason });
        result = renderer.render(layers.slice(0, result.unsupported));
      } else {
        this.stoppedAt.set(null);
      }
      const image = this.comparing() || !('image' in result) ? renderer.original : result.image;
      if (image) engine.present(image, this.canvas().nativeElement);
      await engine.done();
      // Work the GPU refused (out of memory, say) leaves the canvas blank or
      // stale rather than throwing.
      const refused = engine.takeError();
      if (refused) throw new Error(refused.message);
      if (!this.comparing()) this.renderMs.set(performance.now() - start);
      this.failed.set(false);
    } catch (err) {
      // Say so, and carry on with the next change.
      console.error('Live preview:', err);
      this.failed.set(true);
    } finally {
      this.running = false;
      if (this.paused()) renderer.clearCache();
      else if (this.dirty) requestAnimationFrame(() => this.frame());
    }
  }

  // Press and hold (mouse, touch or pen) on the photo to see the original.
  startCompare(event: PointerEvent): void {
    if (this.mode() !== 'live' || this.paused()) return;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    this.comparing.set(true);
  }

  stopCompare(): void {
    this.comparing.set(false);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.renderer?.destroy();
    this.renderer = null;
  }
}
