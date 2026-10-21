// What the live preview, stacks and full-size filtering need from a filter
// engine: WebGPU's (engine.ts) or, where a browser has no WebGPU, WebGL2's
// (webgl2/engine.ts). Both run the server's filter plans.
import type { AdapterInfo, NativePlan } from '../../../server/lib/webgpu/engine';

// An image on the GPU (straight-alpha RGBA8, row by row). Each engine has
// its own kind; only width and height are anyone else's business.
export interface EngineImage {
  readonly width: number;
  readonly height: number;
}

// The limits full-size filtering fits photos to, named as WebGPU names them.
export interface EngineLimits {
  readonly maxStorageBufferBindingSize: number;
  readonly maxBufferSize: number;
  readonly maxComputeWorkgroupsPerDimension: number;
  readonly maxTextureDimension2D: number;
}

export interface FilterEngine {
  readonly backend: 'WebGPU' | 'WebGL2';
  readonly adapterInfo: AdapterInfo;
  readonly device: {
    // Resolves when the GPU is lost (a driver reset, say).
    readonly lost: Promise<unknown>;
    readonly limits: EngineLimits;
    destroy(): void;
  };
  lost: boolean;

  checked<T>(fn: () => T | Promise<T>): Promise<T>;
  takeError(): { message: string } | null;
  preparePipelines(names: string[]): Promise<void>;
  hasPipelines(names: string[]): boolean;
  prepare(names: string[]): Promise<void>;
  createImage(width: number, height: number, rgba?: ArrayBufferView): EngineImage;
  release(image: EngineImage | null | undefined): void;
  run(
    plan: NativePlan,
    src: EngineImage,
    extras?: Record<string, EngineImage>,
    outputSize?: { width: number; height: number },
  ): EngineImage;
  readPixels(image: EngineImage): Promise<Uint8Array>;
  done(): Promise<void>;
  // Draws an image onto a canvas at its own size (CSS scales it).
  present(image: EngineImage, canvas: HTMLCanvasElement | OffscreenCanvas): void;
  imageFromFrame(
    source: HTMLVideoElement | ImageBitmap | HTMLCanvasElement | OffscreenCanvas | VideoFrame,
    sourceWidth: number,
    sourceHeight: number,
    width: number,
    height: number,
    into?: EngineImage | null,
  ): EngineImage;
  releaseFrame(): void;
}
