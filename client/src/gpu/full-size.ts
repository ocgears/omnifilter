// Filtering a photo at full size on this device's GPU, as the server would:
// the photo straight onto the GPU, the stack's layers one at a time (waiting
// for each, so no single submission is long enough for a phone's GPU
// watchdog to reset the device), then back off it and encoded as a file.
// Runs in a Web Worker (full-size.worker.ts), so the page stays responsive,
// but has no worker-only code, so it can be tested on its own.
//
// Photos too big for the GPU's limits run scaled down and are enlarged
// again at the end, the same way the server fits filters to a small GPU
// (server/lib/device_choice.js, which this uses with the GPU's own limits).
import deviceChoice from '../../../server/lib/device_choice.js';
import { GpuEngine, GpuImage, NativePlan } from './engine';
import { buildPlan, filterDef, normalizeParams, workingSize } from './filters';
import { StackLayer, StackRenderer } from './stack';

// The GPU's limits in the shape device_choice.js takes (as the server's
// WebGPU backend describes its device: server/lib/webgpu/worker.js).
// maxBytes caps the largest buffer, for testing the scaled-down path.
export interface DeviceLimits {
  name: string;
  maxAllocBytes: number;
  globalMemBytes: number;
  imageSupport: boolean;
  image2dMaxWidth: number;
  image2dMaxHeight: number;
  maxTextureSide: number;
}

// Browsers don't say how much memory the GPU has; a few times the largest
// buffer is a fair guess, and phones share it with everything else.
const MEMORY_FROM_BUFFERS = 3;

export function deviceLimits(engine: GpuEngine, maxBytes?: number): DeviceLimits {
  const limits = engine.device.limits;
  let maxAlloc = Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize);
  if (maxBytes && maxBytes > 0) maxAlloc = Math.min(maxAlloc, maxBytes);
  const info = engine.adapterInfo;
  return {
    name:
      info.description ||
      [info.vendor, info.architecture].filter(Boolean).join(' ') ||
      "this device's GPU",
    maxAllocBytes: maxAlloc,
    globalMemBytes: maxAlloc * MEMORY_FROM_BUFFERS,
    imageSupport: true,
    image2dMaxWidth: limits.maxComputeWorkgroupsPerDimension * 8,
    image2dMaxHeight: limits.maxComputeWorkgroupsPerDimension * 8,
    maxTextureSide: limits.maxTextureDimension2D,
  };
}

const pixels = (w: number, h: number) => w * h * 4;

// What one layer needs at a photo size, as device_choice.js measures plans.
function layerFits(
  layer: StackLayer,
  width: number,
  height: number,
  limits: DeviceLimits,
): number {
  const def = filterDef(layer.tOption);
  if (!def) return 0;
  const params = normalizeParams(def, layer.params);
  const size = workingSize(def, params, width, height);
  const built = buildPlan(layer.tOption, size.width, size.height, layer.params);
  if (!('plan' in built)) return 0;
  const needs = deviceChoice.planNeeds(built.plan as NativePlan, size.width, size.height);
  // Besides its own buffers: the layer's input and its blend's result.
  needs.totalBytes += 2 * pixels(width, height);
  return deviceChoice.fitScale(needs, limits);
}

// The size to run a stack at for a photo of width x height: the photo's own
// size if every layer fits the GPU, else the largest smaller size that does.
// null if a layer can't run on this GPU at any size.
export function runSize(
  layers: readonly StackLayer[],
  width: number,
  height: number,
  limits: DeviceLimits,
): { width: number; height: number } | null {
  let w = width;
  let h = height;
  // The photo goes onto the GPU as a texture first.
  const side = Math.max(w, h);
  if (side > limits.maxTextureSide) {
    const k = limits.maxTextureSide / side;
    w = Math.max(1, Math.floor(w * k));
    h = Math.max(1, Math.floor(h * k));
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    let fit = 1;
    for (const layer of layers) {
      const f = layerFits(layer, w, h, limits);
      if (f === 0) return null;
      fit = Math.min(fit, f);
    }
    if (fit >= 1) return { width: w, height: h };
    // A little more than needed, since not every buffer scales exactly.
    w = Math.max(1, Math.floor(w * fit * 0.97));
    h = Math.max(1, Math.floor(h * fit * 0.97));
  }
  return null;
}

export interface FullSizeProgress {
  // 'upload', 'filter' (with done of total layers), 'readback', 'encode'
  stage: string;
  done: number;
  total: number;
}

export interface FullSizePixels {
  rgba: Uint8Array;
  width: number;
  height: number;
  // The size the filters ran at, if smaller than the photo.
  ranAt: { width: number; height: number } | null;
  timings: { upload: number; filters: number; readback: number };
}

export class FullSizeError extends Error {}

// Filters a decoded photo at full size. Each layer is waited for before the
// next, and `cancelled` is asked between them.
export async function filterFullSize(
  engine: GpuEngine,
  bitmap: ImageBitmap,
  layers: readonly StackLayer[],
  blendModes: readonly string[],
  options: {
    maxBytes?: number;
    onProgress?: (p: FullSizeProgress) => void;
    cancelled?: () => boolean;
  } = {},
): Promise<FullSizePixels> {
  const width = bitmap.width;
  const height = bitmap.height;
  const limits = deviceLimits(engine, options.maxBytes);
  const size = runSize(layers, width, height, limits);
  if (!size) throw new FullSizeError("These filters can't run on " + limits.name + '.');
  const scaled = size.width !== width || size.height !== height;
  const progress = options.onProgress ?? (() => undefined);
  const check = () => {
    if (options.cancelled?.()) throw new FullSizeError('Cancelled.');
  };
  const now = () => performance.now();

  let start = now();
  progress({ stage: 'upload', done: 0, total: layers.length });
  let image: GpuImage = engine.imageFromFrame(bitmap, width, height, size.width, size.height);
  engine.releaseFrame();
  await engine.done();
  const upload = now() - start;

  start = now();
  const renderer = new StackRenderer(engine, blendModes);
  try {
    for (let n = 0; n < layers.length; n++) {
      check();
      progress({ stage: 'filter', done: n, total: layers.length });
      const next = renderer.apply(layers[n], image, size.width, size.height);
      engine.release(image);
      image = next;
      await engine.done();
    }
    if (scaled) {
      const full = renderer.resize(image, width, height);
      engine.release(image);
      image = full;
      await engine.done();
    }
    check();
    const filters = now() - start;

    start = now();
    progress({ stage: 'readback', done: layers.length, total: layers.length });
    const rgba = await engine.readPixels(image);
    return {
      rgba,
      width,
      height,
      ranAt: scaled ? size : null,
      timings: { upload, filters, readback: now() - start },
    };
  } finally {
    engine.release(image);
    renderer.destroy();
  }
}

// Whether any pixel is see-through (RGBA, straight alpha).
export function hasTransparency(rgba: Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return true;
  return false;
}

// The pixels as a file: a JPEG, or a PNG where there's transparency, as the
// server encodes its results (server/lib/image_codec.js).
export async function encodePixels(rgba: Uint8Array, width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new FullSizeError("This browser can't encode images here.");
  const clamped = new Uint8ClampedArray(
    rgba.buffer as ArrayBuffer,
    rgba.byteOffset,
    rgba.byteLength,
  );
  context.putImageData(new ImageData(clamped, width, height), 0, 0);
  return hasTransparency(rgba)
    ? canvas.convertToBlob({ type: 'image/png' })
    : canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
}
