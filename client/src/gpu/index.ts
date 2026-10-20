// The browser's filter engine: the server's filter plans run with WebGPU,
// or WebGL2 where there's no WebGPU. See engine.ts, server/lib/webgpu (the
// engine and WGSL kernels the server's WebGPU backend shares), webgl2/ (the
// same kernels for WebGL2), filters.ts (the shared filter definitions) and
// stack.ts (filter stacks).
import { GpuEngine } from './engine';
import type { FilterEngine } from './engine-api';
import { allFilterNames, buildPlan, previewable } from './filters';
import { StackLayer, StackRenderer } from './stack';

export { GpuEngine } from './engine';
export type { NativePlan } from './engine';
export type { EngineImage, FilterEngine } from './engine-api';
export { allFilterNames, previewable };
export { StackRenderer } from './stack';
export type { StackLayer, StackResult } from './stack';

// For the end-to-end tests: use WebGL2 even where there's WebGPU.
export function forceWebgl2(): boolean {
  return !!(globalThis as { OMNIFILTER_FORCE_WEBGL2?: boolean }).OMNIFILTER_FORCE_WEBGL2;
}

async function createEngine(): Promise<FilterEngine | null> {
  const webgpu = forceWebgl2() ? null : await GpuEngine.create();
  if (webgpu) return webgpu;
  // A chunk of its own, loaded only where it's needed.
  const { GlEngine } = await import('./webgl2/engine');
  return GlEngine.create();
}

let shared: Promise<FilterEngine | null> | null = null;

// One engine for the page, made the first time it's asked for: WebGPU's,
// or WebGL2's where there's no WebGPU; null where there's neither. A lost
// device (driver reset) makes a new one.
export function gpuEngine(): Promise<FilterEngine | null> {
  if (!shared) shared = createEngine();
  return shared.then((engine) => {
    if (engine && engine.lost) {
      shared = createEngine();
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
  // 'WebGPU', 'WebGL2' or null.
  backend(): Promise<string | null>;
  // Destroys the GPU device, as a driver reset would, to test recovery.
  loseDevice(): Promise<void>;
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
    if (!e) throw new Error('Neither WebGPU nor WebGL2 is available');
    return e;
  };
  win.omnifilterGpu = {
    available: async () => !!(await gpuEngine()),
    backend: async () => (await gpuEngine())?.backend ?? null,
    async loseDevice() {
      const e = await engine();
      e.device.destroy();
      await e.device.lost;
    },
    filters: () => allFilterNames(),
    previewable: (name) => previewable(name),
    async compileAll() {
      const e = await engine();
      const errors: string[] = [];
      for (const name of GpuEngine.kernelNames()) {
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
