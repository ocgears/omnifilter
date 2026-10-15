import { GpuEngine, GpuImage, NativePlan } from './engine';
import { StackLayer, StackRenderer } from './stack';

// Stands in for the GPU: records each plan it's asked to run.
function fakeEngine() {
  const runs: { kernels: string[]; size: string }[] = [];
  let live = 0;
  const image = (width: number, height: number): GpuImage => {
    live++;
    return { buffer: { destroy() {} } as unknown as GPUBuffer, width, height };
  };
  const engine = {
    createImage: (w: number, h: number) => image(w, h),
    run(plan: NativePlan, src: GpuImage, _extras = {}, out?: { width: number; height: number }) {
      runs.push({ kernels: plan.passes.map((p) => p.kernel), size: src.width + 'x' + src.height });
      return image(out?.width ?? src.width, out?.height ?? src.height);
    },
    release(img: GpuImage | null) {
      if (img) live--;
    },
  };
  return { engine: engine as unknown as GpuEngine, runs, live: () => live };
}

const MODES = ['normal', 'multiply', 'screen'];
const layer = (tOption: string, extra: Partial<StackLayer> = {}): StackLayer => ({
  tOption,
  params: {},
  amount: 100,
  blend: 'normal',
  ...extra,
});

describe('StackRenderer', () => {
  it('runs each layer once, and reruns only from the layer that changed', () => {
    const { engine, runs } = fakeEngine();
    const r = new StackRenderer(engine, MODES);
    r.setSource(new Uint8Array(40 * 30 * 4), 40, 30);
    const layers = [layer('invert'), layer('sepia'), layer('posterize')];
    expect('image' in r.render(layers)).toBe(true);
    expect(runs.map((x) => x.kernels[0])).toEqual(['color_matrix', 'color_matrix', 'posterize']);

    runs.length = 0;
    r.render(layers);
    expect(runs).toEqual([]);

    r.render([layers[0], layer('sepia', { params: { amount: 40 } }), layers[2]]);
    expect(runs.map((x) => x.kernels[0])).toEqual(['color_matrix', 'posterize']);
  });

  it("blends a layer that isn't at full strength in normal mode", () => {
    const { engine, runs } = fakeEngine();
    const r = new StackRenderer(engine, MODES);
    r.setSource(new Uint8Array(8 * 8 * 4), 8, 8);
    r.render([layer('invert', { blend: 'screen', amount: 50 })]);
    expect(runs.map((x) => x.kernels)).toEqual([['color_matrix'], ['blend_layers']]);
  });

  it("stops at a layer the browser can't run, and says why", () => {
    const { engine } = fakeEngine();
    const r = new StackRenderer(engine, MODES);
    r.setSource(new Uint8Array(8 * 8 * 4), 8, 8);
    expect(r.render([layer('invert'), layer('style_candy')])).toEqual({
      unsupported: 1,
      reason: 'runs on the server only',
    });
  });

  it("runs working-size filters at the size the server would, from the full photo's size", () => {
    const { engine, runs } = fakeEngine();
    const r = new StackRenderer(engine, MODES);
    // A 400 x 300 preview of a 4000 x 3000 photo; bilateral works at 1000 px here.
    r.setSource(new Uint8Array(400 * 300 * 4), 400, 300, 4000, 3000);
    r.render([layer('bilateral', { params: { detail: 1000 } })]);
    expect(runs.map((x) => x.kernels[0] + ' ' + x.size)).toEqual([
      'resize 400x300',
      'bilateral 1000x750',
      'resize 1000x750',
    ]);
  });

  it('can cap the working size, for quick thumbnails', () => {
    const { engine, runs } = fakeEngine();
    const r = new StackRenderer(engine, MODES, 200);
    r.setSource(new Uint8Array(100 * 75 * 4), 100, 75, 4000, 3000);
    r.render([layer('bilateral', { params: { detail: 1000 } })]);
    expect(runs.map((x) => x.kernels[0] + ' ' + x.size)).toEqual([
      'resize 100x75',
      'bilateral 200x150',
      'resize 200x150',
    ]);
  });

  it('frees what it made', () => {
    const { engine, live } = fakeEngine();
    const r = new StackRenderer(engine, MODES);
    r.setSource(new Uint8Array(8 * 8 * 4), 8, 8);
    r.render([layer('invert'), layer('sepia', { blend: 'multiply', amount: 30 })]);
    r.render([layer('posterize')]);
    r.destroy();
    expect(live()).toBe(0);
  });
});
