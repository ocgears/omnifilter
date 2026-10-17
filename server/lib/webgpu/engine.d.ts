// Types for engine.js, for the TypeScript client.
import { Kernel } from './kernel';

export interface PlanBuffer {
  name: string;
  bytes: number;
  init?: ArrayBufferView;
  zero?: boolean;
}

export type PlanArg =
  | { buf: string }
  | { img: string; width?: number; height?: number; format?: 'rgba8' | 'rgba32f' }
  | { img3d: string; size: number }
  | { int: number }
  | { float: number }
  | { data: ArrayBufferView };

export interface PlanPass {
  kernel: string;
  args: PlanArg[];
  global?: number[];
  local?: number[];
  band?: number;
}

// A plan as Plan.native() (server/lib/filters/plan.js) makes it.
export interface NativePlan {
  buffers: PlanBuffer[];
  passes: PlanPass[];
  output: string;
}

// An RGBA8 image on the GPU, straight alpha, row by row.
export interface GpuImage {
  buffer: GPUBuffer;
  width: number;
  height: number;
}

export interface AdapterInfo {
  vendor: string;
  architecture: string;
  description: string;
  fallback: boolean;
}

export interface EngineOptions {
  powerPreference?: GPUPowerPreference;
  forceFallbackAdapter?: boolean;
  bands?: boolean;
}

// What checked() throws when the GPU refused work.
export interface GpuError extends Error {
  name: 'GpuError';
  outOfMemory: boolean;
  // What fn returned (an image, say), for the caller to release.
  result?: unknown;
}

export class GpuEngine {
  constructor(device: GPUDevice, adapterInfo: AdapterInfo, options?: EngineOptions);
  readonly device: GPUDevice;
  readonly adapterInfo: AdapterInfo;
  readonly bands: boolean;
  lost: boolean;
  error: GPUError | null;

  static fromGpu<T extends typeof GpuEngine>(
    this: T,
    gpu: GPU | undefined,
    options?: EngineOptions,
  ): Promise<InstanceType<T> | null>;
  static hasKernel(name: string): boolean;
  static kernelNames(): string[];
  static unsupported(plan: NativePlan): string | null;
  static readonly USAGE: {
    MAP_READ: number;
    COPY_SRC: number;
    COPY_DST: number;
    UNIFORM: number;
    STORAGE: number;
  };
  static readonly PIXELS: number;

  // Throws a GpuError (outOfMemory set for running out) if the GPU refused
  // any of fn's work.
  checked<T>(fn: () => T | Promise<T>): Promise<T>;
  takeError(): GPUError | null;
  kernel(name: string): Kernel;
  prepare(names: string[]): Promise<void>;
  createImage(width: number, height: number, rgba?: ArrayBufferView): GpuImage;
  release(image: GpuImage | null | undefined): void;
  run(
    plan: NativePlan,
    src: GpuImage,
    extras?: Record<string, GpuImage>,
    outputSize?: { width: number; height: number },
  ): GpuImage;
  readPixels(image: GpuImage): Promise<Uint8Array>;
  done(): Promise<void>;
  destroy(): void;
}
