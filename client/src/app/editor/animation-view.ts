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
import type { Animation, Animator, EngineImage, FilterEngine } from '../../gpu';
import { PreviewEngine, previewPhoto, smallerPhoto } from './preview-engine';

type Mode = 'starting' | 'live' | 'static' | 'failed';

// How big a touch is, as a fraction of the picture's shorter side.
const TOUCH_RADIUS = 0.04;

// An animated effect on the photo, run on this device's GPU and steered by
// touch: drag a finger (or the mouse) across it. It pauses when the tab is
// hidden, while a full-size photo is being made, and starts paused where the
// system asks for reduced motion.
@Component({
  selector: 'of-animation-view',
  templateUrl: './animation-view.html',
  styleUrl: './animation-view.scss',
})
export class AnimationView implements OnDestroy {
  private readonly engines = inject(PreviewEngine);

  // The photo, as a data URL.
  readonly source = input.required<string>();
  // Makes the effect; a new one restarts it.
  readonly animation = input.required<() => Animation>();
  // What the effect is called, for the canvas's label.
  readonly label = input('Animated effect');
  // The longer side it runs at, in pixels.
  readonly maxSide = input(768);
  // Set while a full-size photo is being made on this GPU.
  readonly paused = input(false);

  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  readonly mode = signal<Mode>('starting');
  readonly playing = signal(false);
  readonly fps = signal<number | null>(null);

  readonly status = computed(() => {
    switch (this.mode()) {
      case 'starting':
        return 'Starting the animation…';
      case 'static':
        return 'Animated effects need a browser with WebGPU or WebGL2.';
      case 'failed':
        return "This device's GPU couldn't run the animation.";
      default: {
        if (this.paused()) return 'Paused while the full-size photo is made.';
        if (!this.playing()) return 'Paused. Drag across the picture to stir it.';
        const fps = this.fps();
        return 'Drag across the picture to stir it' + (fps ? ' · ' + Math.round(fps) + ' fps' : '');
      }
    }
  });

  private engine: FilterEngine | null = null;
  private photo: EngineImage | null = null;
  private animator: Animator | null = null;
  private loading = 0;
  private destroyed = false;
  private readonly onVisibility = () => this.animator?.pause('hidden', document.hidden);
  private readonly motion =
    typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

  constructor() {
    effect(() => {
      void this.load(this.source(), this.animation(), this.maxSide());
    });
    effect(() => {
      const paused = this.paused();
      this.animator?.pause('job', paused);
      this.syncPlaying();
    });
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  private async load(src: string, make: () => Animation, maxSide: number): Promise<void> {
    const token = ++this.loading;
    this.stop();
    this.mode.set('starting');
    try {
      const engine = this.engine ?? (await this.engines.get());
      if (token !== this.loading || this.destroyed) return;
      if (!engine) {
        this.mode.set('static');
        return;
      }
      if (this.engine !== engine) this.watch(engine);
      this.engine = engine;
      const photo = await smallerPhoto(await previewPhoto(src), maxSide);
      if (token !== this.loading || this.destroyed) return;
      const canvas = this.canvas().nativeElement;
      canvas.width = photo.width;
      canvas.height = photo.height;
      this.photo = engine.createImage(photo.width, photo.height, photo.rgba);
      const { Animator } = await import('../../gpu');
      if (token !== this.loading || this.destroyed) return;
      const animator = new Animator(engine, make(), this.photo, {
        canvas,
        onFrame: (fps) => this.fps.set(fps),
        onError: (err) => {
          console.error('Animation:', err);
          this.mode.set('failed');
          this.syncPlaying();
        },
      });
      this.animator = animator;
      if (this.motion?.matches) animator.pause('user');
      if (document.hidden) animator.pause('hidden');
      if (this.paused()) animator.pause('job');
      await animator.start();
      if (token !== this.loading || this.destroyed) return;
      if (this.mode() === 'starting') this.mode.set('live');
      this.syncPlaying();
    } catch (err) {
      console.error('Animation:', err);
      if (token === this.loading) this.mode.set('failed');
    }
  }

  // A lost GPU device takes the state with it: start again on a new one.
  private watch(engine: FilterEngine): void {
    engine.device.lost.then(() => {
      if (this.engine !== engine || this.destroyed) return;
      this.engine = null;
      this.photo = null;
      void this.load(this.source(), this.animation(), this.maxSide());
    });
  }

  private syncPlaying(): void {
    const a = this.animator;
    this.playing.set(!!a && !a.pauseReasons.has('user') && this.mode() === 'live');
  }

  toggle(): void {
    const a = this.animator;
    if (!a || this.mode() !== 'live') return;
    a.pause('user', !a.pauseReasons.has('user'));
    this.syncPlaying();
  }

  reset(): void {
    void this.animator?.reset();
  }

  // Pointer positions as fractions of the picture (the canvas is letterboxed
  // by object-fit: contain, so measure from the picture, not the element).
  private toTouch(event: PointerEvent): { x: number; y: number; radius: number } | null {
    const canvas = this.canvas().nativeElement;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height || !canvas.width || !canvas.height) return null;
    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const w = canvas.width * scale;
    const h = canvas.height * scale;
    const x = (event.clientX - rect.left - (rect.width - w) / 2) / w;
    const y = (event.clientY - rect.top - (rect.height - h) / 2) / h;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y, radius: TOUCH_RADIUS };
  }

  private stirring = false;

  pointerDown(event: PointerEvent): void {
    if (this.mode() !== 'live') return;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    this.stirring = true;
    this.pointerMove(event);
  }

  pointerMove(event: PointerEvent): void {
    if (!this.stirring) return;
    const t = this.toTouch(event);
    if (t) this.animator?.touch(t);
  }

  pointerUp(): void {
    this.stirring = false;
  }

  private stop(): void {
    this.animator?.destroy();
    this.animator = null;
    if (this.photo) this.engine?.release(this.photo);
    this.photo = null;
    this.playing.set(false);
    this.fps.set(null);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.stop();
  }
}
