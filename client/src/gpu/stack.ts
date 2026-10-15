// Runs a stack of filters (server/lib/stack.js) on a photo with WebGPU:
// each filter's plan in turn, each result blended over the image it was
// applied to. Keeps the result after each layer, so changing a setting in
// the third layer only reruns the third layer onwards.
import { GpuEngine, GpuImage, NativePlan } from './engine';
import { buildPlan, filterDef, normalizeParams, workingSize } from './filters';

export interface StackLayer {
  tOption: string;
  params: Record<string, unknown>;
  amount: number;
  blend: string;
}

export type StackResult =
  | { image: GpuImage }
  // The first layer the browser can't run, and why.
  | { unsupported: number; reason: string };

const pixels = (w: number, h: number) => w * h * 4;

export class StackRenderer {
  private source: GpuImage | null = null;
  private fullWidth = 0;
  private fullHeight = 0;
  // cache[n] is the image after the first n + 1 layers, for the layers in keys[n].
  private keys: string[] = [];
  private cache: GpuImage[] = [];

  // blendModes: the blend mode names in the server's order (the order of
  // the blend options in GET /presets), which is how blend.cl numbers them.
  // maxWorkingSide caps the size filters with a working size run at, for
  // quick approximations (thumbnails); by default they match the server.
  constructor(
    readonly engine: GpuEngine,
    private blendModes: readonly string[],
    private readonly maxWorkingSide = Infinity,
  ) {}

  setBlendModes(modes: readonly string[]): void {
    if (modes.join() === this.blendModes.join()) return;
    this.blendModes = modes;
    this.clearCache();
  }

  // The photo to filter, as straight-alpha RGBA at the preview's size, and
  // the size of the full photo the server will filter, which sizes filters
  // that run at a working size the way the server does.
  setSource(
    rgba: ArrayBufferView,
    width: number,
    height: number,
    fullWidth = width,
    fullHeight = height,
  ): void {
    this.clearCache();
    this.engine.release(this.source);
    this.source = this.engine.createImage(width, height, rgba);
    this.fullWidth = fullWidth;
    this.fullHeight = fullHeight;
  }

  // The same with an image already on the GPU, which the renderer then owns
  // (camera frames: see GpuEngine.imageFromFrame).
  setSourceImage(image: GpuImage, fullWidth = image.width, fullHeight = image.height): void {
    this.clearCache();
    if (this.source !== image) this.engine.release(this.source);
    this.source = image;
    this.fullWidth = fullWidth;
    this.fullHeight = fullHeight;
  }

  get original(): GpuImage | null {
    return this.source;
  }

  // Why the browser can't preview a layer, or null if it can.
  static unsupported(layer: StackLayer): string | null {
    const result = buildPlan(layer.tOption, 16, 16, layer.params);
    return 'reason' in result ? result.reason : null;
  }

  render(layers: readonly StackLayer[]): StackResult {
    const src = this.source;
    if (!src) throw new Error('No photo to filter');
    for (let n = 0; n < layers.length; n++) {
      const reason = StackRenderer.unsupported(layers[n]);
      if (reason) return { unsupported: n, reason };
    }

    let image = src;
    for (let n = 0; n < layers.length; n++) {
      const key = JSON.stringify(layers.slice(0, n + 1));
      if (this.keys[n] === key) {
        image = this.cache[n];
        continue;
      }
      // This layer changed, so every cached result from here on is stale.
      this.dropFrom(n);
      image = this.layer(layers[n], image);
      this.keys[n] = key;
      this.cache[n] = image;
    }
    this.dropFrom(layers.length);
    return { image };
  }

  // One layer applied to an image, without the cache: a new image, which
  // the caller owns (input stays the caller's too). fullWidth and fullHeight
  // are the photo's real size, for filters with a working size. For full-size
  // results, where keeping every layer's result would use too much memory.
  apply(layer: StackLayer, input: GpuImage, fullWidth: number, fullHeight: number): GpuImage {
    const reason = StackRenderer.unsupported(layer);
    if (reason) throw new Error(layer.tOption + ' ' + reason);
    this.fullWidth = fullWidth;
    this.fullHeight = fullHeight;
    return this.layer(layer, input);
  }

  private layer(layer: StackLayer, input: GpuImage): GpuImage {
    const filtered = this.filter(layer, input);
    if (layer.amount >= 100 && layer.blend === 'normal') return filtered;
    const mode = Math.max(0, this.blendModes.indexOf(layer.blend));
    const plan: NativePlan = {
      buffers: [{ name: 'out', bytes: pixels(input.width, input.height) }],
      passes: [
        {
          kernel: 'blend_layers',
          args: [
            { buf: 'src' },
            { buf: 'out' },
            { int: input.width },
            { int: input.height },
            { buf: 'base' },
            { int: mode },
            { float: Math.min(100, Math.max(0, layer.amount)) / 100 },
          ],
        },
      ],
      output: 'out',
    };
    const blended = this.engine.run(plan, filtered, { base: input });
    this.engine.release(filtered);
    return blended;
  }

  // One filter, at the size the server would run it at (relative to the
  // full photo), so filters measured in pixels at a working size look the
  // same in the preview as in the result.
  private filter(layer: StackLayer, input: GpuImage): GpuImage {
    const def = filterDef(layer.tOption)!;
    const params = normalizeParams(def, layer.params);
    // The server runs these on a copy of the full photo at the working size
    // and scales the result back up; the preview does the same from its
    // smaller copy, so a radius in pixels covers the same part of the photo.
    let size = def.workingSize
      ? workingSize(def, params, this.fullWidth, this.fullHeight)
      : { width: input.width, height: input.height };
    const longest = Math.max(size.width, size.height);
    if (longest > this.maxWorkingSide) {
      const k = this.maxWorkingSide / longest;
      size = {
        width: Math.max(1, Math.round(size.width * k)),
        height: Math.max(1, Math.round(size.height * k)),
      };
    }
    const resized = size.width !== input.width || size.height !== input.height;
    const at = resized ? this.resize(input, size.width, size.height) : input;
    const built = buildPlan(layer.tOption, at.width, at.height, layer.params);
    if (!('plan' in built)) throw new Error(layer.tOption + ' ' + built.reason);
    const out = this.engine.run(built.plan, at);
    if (!resized) return out;
    this.engine.release(at);
    const back = this.resize(out, input.width, input.height);
    this.engine.release(out);
    return back;
  }

  resize(image: GpuImage, width: number, height: number): GpuImage {
    const plan: NativePlan = {
      buffers: [{ name: 'out', bytes: pixels(width, height) }],
      passes: [
        {
          kernel: 'resize',
          args: [
            { buf: 'src' },
            { buf: 'out' },
            { int: width },
            { int: height },
            { int: image.width },
            { int: image.height },
          ],
          global: [width, height],
        },
      ],
      output: 'out',
    };
    return this.engine.run(plan, image, {}, { width, height });
  }

  private dropFrom(n: number): void {
    for (let k = n; k < this.cache.length; k++) this.engine.release(this.cache[k]);
    this.cache.length = Math.min(this.cache.length, n);
    this.keys.length = Math.min(this.keys.length, n);
  }

  clearCache(): void {
    this.dropFrom(0);
  }

  destroy(): void {
    this.clearCache();
    this.engine.release(this.source);
    this.source = null;
  }
}
