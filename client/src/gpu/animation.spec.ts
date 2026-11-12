import { Animation, Animator, Touch } from './animation';
import type { EngineImage, FilterEngine } from './engine-api';

// A fake engine: present() and done() are recorded, and done() can be held
// open to act as a busy GPU.
function fakeEngine() {
  let release: (() => void) | null = null;
  let hold = false;
  const engine = {
    presented: [] as EngineImage[],
    error: null as { message: string } | null,
    preparePipelines: vi.fn(async () => {}),
    present: vi.fn((image: EngineImage) => engine.presented.push(image)),
    done: vi.fn(() => (hold ? new Promise<void>((r) => (release = r)) : Promise.resolve())),
    takeError: () => {
      const e = engine.error;
      engine.error = null;
      return e;
    },
    hold(on: boolean) {
      hold = on;
    },
    finish() {
      release?.();
      release = null;
    },
  };
  return engine;
}

function fakeAnimation() {
  const image: EngineImage = { width: 4, height: 3 };
  const anim = {
    kernels: ['k1', 'k2'],
    touches: [] as Touch[][],
    start: vi.fn(),
    frame: vi.fn((_e: FilterEngine, _p: EngineImage, t: readonly Touch[]) => {
      anim.touches.push([...t]);
      return image;
    }),
    reset: vi.fn(),
    destroy: vi.fn(),
  };
  return anim;
}

// Frames run when the test says so.
function fakeFrames() {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    requestFrame: (cb: () => void) => {
      pending.set(next, cb);
      return next++;
    },
    cancelFrame: (id: number) => pending.delete(id),
    get count() {
      return pending.size;
    },
    async tick() {
      const cbs = [...pending.values()];
      pending.clear();
      cbs.forEach((cb) => cb());
      for (let n = 0; n < 5; n++) await Promise.resolve();
    },
  };
}

function setup() {
  const engine = fakeEngine();
  const anim = fakeAnimation();
  const frames = fakeFrames();
  let time = 0;
  const onFrame = vi.fn();
  const onError = vi.fn();
  const animator = new Animator(
    engine as unknown as FilterEngine,
    anim as unknown as Animation,
    { width: 4, height: 3 },
    {
      canvas: {} as HTMLCanvasElement,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
      now: () => (time += 16),
      onFrame,
      onError,
    },
  );
  return { engine, anim, frames, animator, onFrame, onError };
}

describe('Animator', () => {
  it('compiles, starts and draws a first frame, then one per display frame', async () => {
    const { engine, anim, frames, animator } = setup();
    await animator.start();
    expect(engine.preparePipelines).toHaveBeenCalledWith(['k1', 'k2']);
    expect(anim.start).toHaveBeenCalledTimes(1);
    expect(animator.frames).toBe(1);
    await frames.tick();
    await frames.tick();
    expect(animator.frames).toBe(3);
    expect(engine.presented.length).toBe(3);
  });

  it('never queues a frame while the GPU is busy with the last one', async () => {
    const { engine, frames, animator } = setup();
    await animator.start();
    engine.hold(true);
    await frames.tick();
    expect(frames.count).toBe(0);
    await frames.tick();
    expect(animator.frames).toBe(1);
    engine.hold(false);
    engine.finish();
    for (let n = 0; n < 5; n++) await Promise.resolve();
    expect(animator.frames).toBe(2);
    expect(frames.count).toBe(1);
  });

  it('runs only when nothing is pausing it', async () => {
    const { frames, animator } = setup();
    await animator.start();
    animator.pause('hidden');
    animator.pause('job');
    expect(animator.running).toBe(false);
    expect(frames.count).toBe(0);
    animator.pause('hidden', false);
    expect(frames.count).toBe(0);
    animator.pause('job', false);
    expect(animator.running).toBe(true);
    expect(frames.count).toBe(1);
  });

  it('hands each touch to exactly one frame, and draws touches while paused', async () => {
    const { anim, frames, animator } = setup();
    await animator.start();
    animator.touch({ x: 0.5, y: 0.5, radius: 0.05 });
    await frames.tick();
    await frames.tick();
    expect(anim.touches.slice(1)).toEqual([[{ x: 0.5, y: 0.5, radius: 0.05 }], []]);

    animator.pause('user');
    animator.touch({ x: 0.1, y: 0.2, radius: 0.05 });
    for (let n = 0; n < 5; n++) await Promise.resolve();
    expect(anim.touches.at(-1)).toEqual([{ x: 0.1, y: 0.2, radius: 0.05 }]);
  });

  it('reports fps only while running', async () => {
    const { frames, animator, onFrame } = setup();
    await animator.start();
    await frames.tick();
    await frames.tick();
    expect(onFrame.mock.calls.at(-1)![0]).toBeCloseTo(1000 / 16);
    animator.pause('user');
    animator.touch({ x: 0, y: 0, radius: 0.1 });
    for (let n = 0; n < 5; n++) await Promise.resolve();
    expect(onFrame.mock.calls.at(-1)![0]).toBeNull();
  });

  it('stops and says so when the GPU refuses a frame', async () => {
    const { engine, frames, animator, onError } = setup();
    await animator.start();
    engine.error = { message: 'out of memory' };
    await frames.tick();
    expect(onError).toHaveBeenCalledWith(new Error('out of memory'));
    expect(animator.running).toBe(false);
    expect(frames.count).toBe(0);
  });

  it('resets, and lets go of its state once destroyed', async () => {
    const { anim, frames, animator } = setup();
    await animator.start();
    await animator.reset();
    expect(anim.reset).toHaveBeenCalledTimes(1);
    animator.destroy();
    animator.destroy();
    expect(anim.destroy).toHaveBeenCalledTimes(1);
    expect(frames.count).toBe(0);
    expect(animator.running).toBe(false);
  });

  it('does not start once destroyed while compiling', async () => {
    const { anim, animator } = setup();
    const started = animator.start();
    animator.destroy();
    await started;
    expect(anim.start).not.toHaveBeenCalled();
    expect(anim.destroy).not.toHaveBeenCalled();
  });
});
