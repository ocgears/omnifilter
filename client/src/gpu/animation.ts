// Animated effects: simulations stepped a little every frame on the GPU,
// steered by touch. An Animation keeps its state in engine images that its
// plans read and write in place (both engines write a plan's output buffers
// where they are), so it works on WebGPU and WebGL2 alike. The Animator runs
// the frame loop. Knows nothing about Angular.
import type { EngineImage, FilterEngine } from './engine-api';

// A touch on the picture: x and y from 0 to 1 across and down, radius as a
// fraction of the shorter side.
export interface Touch {
  x: number;
  y: number;
  radius: number;
}

export interface Animation {
  // The kernels its plans use, compiled before the first frame.
  readonly kernels: readonly string[];
  // Makes its state for this photo (at the size it is shown).
  start(engine: FilterEngine, photo: EngineImage): void;
  // Advances one frame, applying the touches since the last one, and
  // returns the picture to show. The animation owns that image.
  frame(engine: FilterEngine, photo: EngineImage, touches: readonly Touch[]): EngineImage;
  // Back to how start() left it.
  reset(engine: FilterEngine, photo: EngineImage): void;
  destroy(engine: FilterEngine): void;
}

// Why an animator isn't running. It runs only when there are none.
export type PauseReason = 'user' | 'hidden' | 'job' | 'motion';

export interface AnimatorOptions {
  // Where frames are drawn.
  canvas: HTMLCanvasElement | OffscreenCanvas;
  // For tests: the frame scheduler and clock.
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (id: number) => void;
  now?: () => number;
  // Called after each frame drawn, and when a frame fails.
  onFrame?: (fps: number | null) => void;
  onError?: (err: unknown) => void;
}

// Runs an animation at most once per display frame, never queuing a frame
// while the GPU is still busy with the last one (a slow phone just gets
// fewer frames, rather than a growing backlog).
export class Animator {
  private readonly reasons = new Set<PauseReason>();
  private touches: Touch[] = [];
  private scheduled: number | null = null;
  private busy = false;
  private started = false;
  private destroyed = false;
  private readonly requestFrame: (cb: () => void) => number;
  private readonly cancelFrame: (id: number) => void;
  private readonly now: () => number;
  // Frame times for the fps estimate (the last second or so).
  private readonly times: number[] = [];
  frames = 0;

  constructor(
    private readonly engine: FilterEngine,
    private readonly animation: Animation,
    private readonly photo: EngineImage,
    private readonly options: AnimatorOptions,
  ) {
    this.requestFrame = options.requestFrame ?? ((cb) => requestAnimationFrame(cb));
    this.cancelFrame = options.cancelFrame ?? ((id) => cancelAnimationFrame(id));
    this.now = options.now ?? (() => performance.now());
  }

  get running(): boolean {
    return this.reasons.size === 0 && !this.destroyed;
  }

  get pauseReasons(): ReadonlySet<PauseReason> {
    return this.reasons;
  }

  // Compiles the kernels, makes the state and draws the first frame (even
  // while paused, so there's something to see).
  async start(): Promise<void> {
    await this.engine.preparePipelines([...this.animation.kernels]);
    if (this.destroyed) return;
    this.animation.start(this.engine, this.photo);
    this.started = true;
    await this.draw();
    this.schedule();
  }

  pause(reason: PauseReason, paused = true): void {
    if (paused) {
      this.reasons.add(reason);
      if (this.scheduled !== null) this.cancelFrame(this.scheduled);
      this.scheduled = null;
      this.times.length = 0;
    } else {
      this.reasons.delete(reason);
      this.schedule();
    }
  }

  // A touch is applied in the next frame, drawn even while paused.
  touch(t: Touch): void {
    if (this.destroyed) return;
    this.touches.push(t);
    if (!this.running && this.started && !this.busy) void this.draw();
  }

  async reset(): Promise<void> {
    if (!this.started || this.destroyed) return;
    this.touches = [];
    this.animation.reset(this.engine, this.photo);
    if (!this.busy) await this.draw();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.scheduled !== null) this.cancelFrame(this.scheduled);
    this.scheduled = null;
    if (this.started) this.animation.destroy(this.engine);
  }

  private schedule(): void {
    if (!this.running || !this.started || this.scheduled !== null || this.busy) return;
    this.scheduled = this.requestFrame(() => {
      this.scheduled = null;
      if (!this.running) return;
      void this.draw().then(() => this.schedule());
    });
  }

  private async draw(): Promise<void> {
    if (this.busy || this.destroyed) return;
    this.busy = true;
    try {
      const touches = this.touches;
      this.touches = [];
      const image = this.animation.frame(this.engine, this.photo, touches);
      this.engine.present(image, this.options.canvas);
      await this.engine.done();
      const refused = this.engine.takeError();
      if (refused) throw new Error(refused.message);
      this.frames++;
      this.options.onFrame?.(this.fps());
    } catch (err) {
      // Stop rather than fail every frame; the view says so.
      this.reasons.add('user');
      this.options.onError?.(err);
    } finally {
      this.busy = false;
    }
  }

  // Frames per second over about the last second, while running.
  private fps(): number | null {
    if (!this.running) return null;
    const t = this.now();
    this.times.push(t);
    while (this.times.length > 1 && t - this.times[0] > 1000) this.times.shift();
    if (this.times.length < 2) return null;
    return ((this.times.length - 1) * 1000) / (t - this.times[0]);
  }
}
