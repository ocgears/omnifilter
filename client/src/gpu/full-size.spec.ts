import type { GpuEngine } from './engine';
import { DeviceLimits, FullSizeError, filterFullSize, hasTransparency, runSize } from './full-size';

// A GPU whose largest buffer is `mb` megabytes.
const gpu = (mb: number, side = 8192): DeviceLimits => ({
  name: 'Test GPU',
  maxAllocBytes: mb * 1e6,
  globalMemBytes: mb * 3e6,
  imageSupport: true,
  image2dMaxWidth: 65535 * 8,
  image2dMaxHeight: 65535 * 8,
  maxTextureSide: side,
});

const invert = { tOption: 'invert', params: {}, amount: 100, blend: 'normal' };

describe('fitting a full-size photo to the GPU', () => {
  it('runs at the photo\'s own size when it fits', () => {
    expect(runSize([invert], 4000, 3000, gpu(256))).toEqual({ width: 4000, height: 3000 });
  });

  it('runs smaller when a buffer would be too big, keeping the shape', () => {
    // 4000 x 3000 x 4 bytes is 48 MB.
    const size = runSize([invert], 4000, 3000, gpu(12))!;
    expect(size.width * size.height * 4).toBeLessThanOrEqual(12e6);
    expect(size.width / size.height).toBeCloseTo(4 / 3, 1);
  });

  it('runs smaller than the GPU\'s largest texture', () => {
    const size = runSize([invert], 8000, 6000, gpu(1024, 4096))!;
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(4096);
  });

  it('can\'t run a filter the browser doesn\'t have', () => {
    expect(runSize([{ ...invert, tOption: 'style_mosaic' }], 100, 100, gpu(256))).toBeNull();
  });

  it('notices transparency', () => {
    expect(hasTransparency(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]))).toBe(false);
    expect(hasTransparency(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 254]))).toBe(true);
  });
});

// A pretend GPU engine: images are plain objects, and checked() fails the
// way it's told to.
function fakeEngine(opts: { failures?: ('oom' | 'validation')[]; maxBytes?: number } = {}) {
  const failures = [...(opts.failures ?? [])];
  const live = new Set<object>();
  const image = (width: number, height: number) => {
    const made = { buffer: { size: width * height * 4 }, width, height };
    live.add(made);
    return made;
  };
  const maxBytes = opts.maxBytes ?? 1e9;
  const engine = {
    device: {
      limits: {
        maxStorageBufferBindingSize: maxBytes,
        maxBufferSize: maxBytes,
        maxComputeWorkgroupsPerDimension: 65535,
        maxTextureDimension2D: 16384,
      },
    },
    adapterInfo: { vendor: 'test', architecture: '', description: 'Test GPU', fallback: false },
    sizes: [] as string[],
    async checked<T>(fn: () => T | Promise<T>): Promise<T> {
      const result = await fn();
      const failure = failures.shift();
      if (!failure) return result;
      throw Object.assign(new Error('refused'), {
        name: 'GpuError',
        outOfMemory: failure === 'oom',
        result,
      });
    },
    imageFromFrame(_s: unknown, _sw: number, _sh: number, w: number, h: number) {
      engine.sizes.push(w + 'x' + h);
      return image(w, h);
    },
    run(_plan: unknown, src: { width: number; height: number }, _x?: unknown, out?: { width: number; height: number }) {
      return image(out?.width ?? src.width, out?.height ?? src.height);
    },
    releaseFrame: () => undefined,
    done: async () => undefined,
    release: (img: object | null | undefined) => img && live.delete(img),
    readPixels: async (img: { width: number; height: number }) => new Uint8Array(img.width * img.height * 4),
    live,
  };
  return engine;
}

const bitmap = (width: number, height: number) => ({ width, height, close: () => undefined }) as ImageBitmap;

describe('filtering at full size', () => {
  beforeEach(() => {
    // jsdom has no createImageBitmap; the scaled-down copy only needs a size.
    (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async (
      _b: unknown,
      o: { resizeWidth: number; resizeHeight: number },
    ) => bitmap(o.resizeWidth, o.resizeHeight);
  });

  it('starts again smaller when the GPU runs out of memory', async () => {
    const engine = fakeEngine({ failures: ['oom'] });
    const out = await filterFullSize(engine as unknown as GpuEngine, bitmap(1000, 800), [invert], []);
    expect(engine.sizes).toEqual(['1000x800', '700x560']);
    expect(out.ranAt).toEqual({ width: 700, height: 560 });
    expect([out.width, out.height]).toEqual([1000, 800]);
    // Enlarged on the GPU: it fits one of its buffers.
    expect([out.rgbaWidth, out.rgbaHeight]).toEqual([1000, 800]);
    expect(engine.live.size).toBe(0);
  });

  it('says so, rather than handing back a blank photo, when the GPU refuses the work', async () => {
    const engine = fakeEngine({ failures: ['validation'] });
    await expect(
      filterFullSize(engine as unknown as GpuEngine, bitmap(100, 80), [invert], []),
    ).rejects.toThrow(FullSizeError);
    expect(engine.live.size).toBe(0);
  });

  it('gives up after running out of memory three times', async () => {
    const engine = fakeEngine({ failures: ['oom', 'oom', 'oom'] });
    await expect(
      filterFullSize(engine as unknown as GpuEngine, bitmap(100, 80), [invert], []),
    ).rejects.toThrow(/ran out of memory/);
  });

  it('leaves enlarging to the browser when the full-size result is too big for a GPU buffer', async () => {
    // 4 MB buffers: 2400 x 1600 runs at about a million pixels.
    const engine = fakeEngine({ maxBytes: 4e6 });
    const out = await filterFullSize(engine as unknown as GpuEngine, bitmap(2400, 1600), [invert], []);
    expect(out.ranAt).not.toBeNull();
    expect([out.rgbaWidth, out.rgbaHeight]).toEqual([out.ranAt!.width, out.ranAt!.height]);
    expect([out.width, out.height]).toEqual([2400, 1600]);
    expect(out.rgba.length).toBe(out.rgbaWidth * out.rgbaHeight * 4);
  });
});
