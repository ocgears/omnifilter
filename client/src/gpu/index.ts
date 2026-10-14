// The browser's filter engine: the server's filter plans run with WebGPU.
// See engine.ts (plans), kernel.ts and kernels/ (the WGSL), filters.ts (the
// shared filter definitions) and stack.ts (filter stacks).
import { GpuEngine } from './engine';
import { allFilterNames, buildPlan, previewable } from './filters';
import { KERNELS } from './kernels';
import { StackLayer, StackRenderer } from './stack';

export { GpuEngine } from './engine';
export type { GpuImage, NativePlan } from './engine';
export { allFilterNames, previewable };
export { StackRenderer } from './stack';
export type { StackLayer, StackResult } from './stack';

let shared: Promise<GpuEngine | null> | null = null;

// One engine for the page, made the first time it's asked for; null where
// WebGPU isn't available. A lost device (driver reset) makes a new one.
export function gpuEngine(): Promise<GpuEngine | null> {
  if (!shared) shared = GpuEngine.create();
  return shared.then((engine) => {
    if (engine && engine.lost) {
      shared = GpuEngine.create();
      return shared;
    }
    return engine;
  });
}

// window.omnifilterGpu: runs filters and stacks on raw pixels, for the
// end-to-end tests that compare the browser's results with the server's,
// and for trying kernels out from the console.
export interface GpuDebugApi {
  available(): Promise<boolean>;
  // The filters bundled into the client, and whether each can be previewed.
  filters(): string[];
  previewable(name: string): boolean;
  compileAll(): Promise<string[]>;
  runFilter(
    name: string,
    rgba: number[] | Uint8Array,
    width: number,
    height: number,
    params?: Record<string, unknown>,
  ): Promise<number[]>;
  runStack(
    layers: StackLayer[],
    blendModes: string[],
    rgba: number[] | Uint8Array,
    width: number,
    height: number,
  ): Promise<number[]>;
}

export function installDebugApi(win: Window & { omnifilterGpu?: GpuDebugApi }): void {
  const engine = async () => {
    const e = await gpuEngine();
    if (!e) throw new Error('WebGPU is not available');
    return e;
  };
  win.omnifilterGpu = {
    available: async () => !!(await gpuEngine()),
    filters: () => allFilterNames(),
    previewable: (name) => previewable(name),
    async compileAll() {
      const e = await engine();
      const errors: string[] = [];
      for (const name of Object.keys(KERNELS)) {
        try {
          await e.prepare([name]);
        } catch (err) {
          errors.push((err as Error).message);
        }
      }
      return errors;
    },
    async runFilter(name, rgba, width, height, params = {}) {
      const e = await engine();
      const built = buildPlan(name, width, height, params);
      if (!('plan' in built)) throw new Error(name + ' ' + built.reason);
      const src = e.createImage(width, height, Uint8Array.from(rgba));
      const out = e.run(built.plan, src);
      const pixels = await e.readPixels(out);
      e.release(src);
      e.release(out);
      return Array.from(pixels);
    },
    async runStack(layers, blendModes, rgba, width, height) {
      const e = await engine();
      const renderer = new StackRenderer(e, blendModes);
      renderer.setSource(Uint8Array.from(rgba), width, height);
      const result = renderer.render(layers);
      if (!('image' in result))
        throw new Error('Layer ' + (result.unsupported + 1) + ' ' + result.reason);
      const pixels = await e.readPixels(result.image);
      renderer.destroy();
      return Array.from(pixels);
    },
  };
}
