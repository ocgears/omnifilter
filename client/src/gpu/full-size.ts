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
import type { GpuError, NativePlan } from './engine';
import type { EngineImage, FilterEngine } from './engine-api';
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

export function deviceLimits(engine: FilterEngine, maxBytes?: number): DeviceLimits {
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
function layerFits(layer: StackLayer, width: number, height: number, limits: DeviceLimits): number {
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
  // The filtered pixels: rgbaWidth x rgbaHeight, which is the photo's own
  // size unless the result is too big for one of the GPU's buffers, when
  // it's the size the filters ran at and encodePixels enlarges it.
  rgba: Uint8Array;
  rgbaWidth: number;
  rgbaHeight: number;
  // The photo's size, which the file will be.
  width: number;
  height: number;
  // The size the filters ran at, if smaller than the photo.
  ranAt: { width: number; height: number } | null;
  timings: { upload: number; filters: number; readback: number };
}

export class FullSizeError extends Error {}

// How many times a run that runs out of GPU memory starts again smaller.
const RETRIES = 2;

const outOfMemory = (err: unknown) =>
  (err as GpuError | null)?.name === 'GpuError' && (err as GpuError).outOfMemory;

// Filters a decoded photo at full size. Each layer is waited for before the
// next, and `cancelled` is asked between them. If the GPU runs out of memory
// it starts again at about half the pixels, twice at most: a phone's GPU
// shares its memory with everything else, so it can have less to spare than
// its limits say. Any other work the GPU refuses is an error, rather than a
// blank photo.
export async function filterFullSize(
  engine: FilterEngine,
  bitmap: ImageBitmap,
  layers: readonly StackLayer[],
  blendModes: readonly string[],
  options: {
    maxBytes?: number;
    onProgress?: (p: FullSizeProgress) => void;
    cancelled?: () => boolean;
  } = {},
): Promise<FullSizePixels> {
  const limits = deviceLimits(engine, options.maxBytes);
  let size = runSize(layers, bitmap.width, bitmap.height, limits);
  if (!size) throw new FullSizeError("These filters can't run on " + limits.name + '.');
  for (let attempt = 0; ; attempt++) {
    try {
      return await filterAt(engine, bitmap, layers, blendModes, size, limits, options);
    } catch (err) {
      if (outOfMemory(err) && attempt < RETRIES) {
        console.warn(
          'Out of GPU memory at ' + size.width + 'x' + size.height + '; trying smaller.',
        );
        size = {
          width: Math.max(1, Math.floor(size.width * 0.7)),
          height: Math.max(1, Math.floor(size.height * 0.7)),
        };
        continue;
      }
      if ((err as GpuError | null)?.name === 'GpuError') {
        console.error('Full size:', err);
        throw new FullSizeError(
          outOfMemory(err)
            ? limits.name + ' ran out of memory for a photo this size. Try a smaller photo.'
            : limits.name + " couldn't run these filters on this photo.",
        );
      }
      throw err;
    }
  }
}

async function filterAt(
  engine: FilterEngine,
  bitmap: ImageBitmap,
  layers: readonly StackLayer[],
  blendModes: readonly string[],
  size: { width: number; height: number },
  limits: DeviceLimits,
  options: { onProgress?: (p: FullSizeProgress) => void; cancelled?: () => boolean },
): Promise<FullSizePixels> {
  const width = bitmap.width;
  const height = bitmap.height;
  const scaled = size.width !== width || size.height !== height;
  const progress = options.onProgress ?? (() => undefined);
  const check = () => {
    if (options.cancelled?.()) throw new FullSizeError('Cancelled.');
  };
  const now = () => performance.now();
  // Runs work on the GPU and waits for it; an image it made is released if
  // the GPU refused some of the work.
  const gpu = (work: () => EngineImage) =>
    engine
      .checked(async () => {
        const made = work();
        await engine.done();
        return made;
      })
      .catch((err) => {
        engine.release((err as GpuError).result as EngineImage | undefined);
        throw err;
      });

  let start = now();
  progress({ stage: 'upload', done: 0, total: layers.length });
  // The photo goes onto the GPU as a texture, which can't be bigger than
  // the GPU allows, so one that runs smaller is scaled down first, here.
  const source = scaled
    ? await createImageBitmap(bitmap, {
        resizeWidth: size.width,
        resizeHeight: size.height,
        resizeQuality: 'high',
      })
    : bitmap;
  let image: EngineImage | null = null;
  try {
    image = await gpu(() =>
      engine.imageFromFrame(source, source.width, source.height, size.width, size.height),
    );
  } finally {
    if (source !== bitmap) source.close();
    engine.releaseFrame();
  }
  const upload = now() - start;

  start = now();
  const renderer = new StackRenderer(engine, blendModes);
  try {
    for (let n = 0; n < layers.length; n++) {
      check();
      progress({ stage: 'filter', done: n, total: layers.length });
      const input: EngineImage = image;
      const next = await gpu(() => renderer.apply(layers[n], input, size.width, size.height));
      engine.release(image);
      image = next;
    }
    // Back to the photo's size, on the GPU if the result fits in one of its
    // buffers; if not, the browser enlarges it when encoding.
    let rgbaSize = size;
    if (scaled && pixels(width, height) <= limits.maxAllocBytes) {
      const small: EngineImage = image;
      const full = await gpu(() => renderer.resize(small, width, height));
      engine.release(image);
      image = full;
      rgbaSize = { width, height };
    }
    check();
    const filters = now() - start;

    start = now();
    progress({ stage: 'readback', done: layers.length, total: layers.length });
    const result: EngineImage = image;
    const rgba = await engine.checked(() => engine.readPixels(result));
    return {
      rgba,
      rgbaWidth: rgbaSize.width,
      rgbaHeight: rgbaSize.height,
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

// The pixels as a file of width x height (the browser enlarges them if
// they're smaller): a JPEG, or a PNG where there's transparency, as the
// server encodes its results (server/lib/image_codec.js).
export async function encodePixels(
  rgba: Uint8Array,
  rgbaWidth: number,
  rgbaHeight: number,
  width = rgbaWidth,
  height = rgbaHeight,
): Promise<Blob> {
  const clamped = new Uint8ClampedArray(
    rgba.buffer as ArrayBuffer,
    rgba.byteOffset,
    rgba.byteLength,
  );
  const pixelsCanvas = new OffscreenCanvas(rgbaWidth, rgbaHeight);
  const pixelsContext = pixelsCanvas.getContext('2d');
  if (!pixelsContext) throw new FullSizeError("This browser can't encode images here.");
  pixelsContext.putImageData(new ImageData(clamped, rgbaWidth, rgbaHeight), 0, 0);
  let canvas = pixelsCanvas;
  if (width !== rgbaWidth || height !== rgbaHeight) {
    canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new FullSizeError("This browser can't encode images here.");
    context.imageSmoothingQuality = 'high';
    context.drawImage(pixelsCanvas, 0, 0, width, height);
    pixelsCanvas.width = pixelsCanvas.height = 1;
  }
  return hasTransparency(rgba)
    ? canvas.convertToBlob({ type: 'image/png' })
    : canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
}

// One photo filtered and encoded, as the page asks for it: what the
// full-size worker does, and what the page does itself where the browser
// has no GPU in workers (WebKit has WebGL2 only on the page).
export interface FullSizeJob {
  file: Blob;
  layers: StackLayer[];
  blendModes: string[];
  maxBytes?: number;
}

export interface FullSizeResult {
  file: Blob;
  width: number;
  height: number;
  ranAt: { width: number; height: number } | null;
  device: string;
  timings: {
    decode: number;
    upload: number;
    filters: number;
    readback: number;
    encode: number;
    total: number;
  };
}

export async function fullSizeJob(
  engine: FilterEngine,
  job: FullSizeJob,
  onProgress: (p: FullSizeProgress) => void,
  cancelled?: () => boolean,
): Promise<FullSizeResult> {
  const started = performance.now();
  let t = performance.now();
  // Applies the photo's EXIF orientation, as the server does.
  const bitmap = await createImageBitmap(job.file, { imageOrientation: 'from-image' });
  const decode = performance.now() - t;
  let out;
  try {
    out = await filterFullSize(engine, bitmap, job.layers, job.blendModes, {
      maxBytes: job.maxBytes,
      onProgress,
      cancelled,
    });
  } finally {
    bitmap.close();
  }
  t = performance.now();
  onProgress({ stage: 'encode', done: job.layers.length, total: job.layers.length });
  const file = await encodePixels(out.rgba, out.rgbaWidth, out.rgbaHeight, out.width, out.height);
  const encode = performance.now() - t;
  return {
    file,
    width: out.width,
    height: out.height,
    ranAt: out.ranAt,
    device: deviceLimits(engine).name,
    timings: { decode, ...out.timings, encode, total: performance.now() - started },
  };
}

// What to tell the user about a job that failed.
export function fullSizeMessage(engine: FilterEngine, err: unknown): string {
  const lost = engine.lost ? ' (the GPU was reset; try again)' : '';
  const message =
    err instanceof FullSizeError ? err.message : 'Filtering failed: ' + (err as Error).message;
  return message + lost;
}
