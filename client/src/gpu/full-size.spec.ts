import { DeviceLimits, hasTransparency, runSize } from './full-size';

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
