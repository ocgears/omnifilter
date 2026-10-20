// The kernels WebGL2 can't run as fragment shaders, on the CPU instead:
// histograms (WGSL's atomics), their prefix sums (work-group memory) and
// scattering Voronoi seeds. Each does what its WGSL version in
// server/lib/webgpu/kernels does, with f32 arithmetic where that does
// (Math.fround), so the results match. They're cheap next to reading the
// image back, which the engine does for them.

// A kernel's arguments, by the names its WGSL declares.
export interface CpuArgs {
  // A buffer's 32-bit words (a copy: store() to change the buffer).
  words(name: string): Uint32Array;
  store(name: string, words: Uint32Array): void;
  scalar(name: string): number;
  // The plan's global size.
  global: [number, number];
}

export type CpuKernel = (args: CpuArgs) => void;

const f = Math.fround;
const C_R = f(0.2126);
const C_G = f(0.7152);
const C_B = f(0.0722);

// luma_bin in common.js, in f32.
export function lumaBin(p: number): number {
  const v = f(
    f(f(f(C_R * (p & 255)) + f(C_G * ((p >>> 8) & 255))) + f(C_B * ((p >>> 16) & 255))) + 0.5,
  );
  return Math.min(255, Math.max(0, Math.trunc(v)));
}

const asInts = (w: Uint32Array) => new Int32Array(w.buffer, w.byteOffset, w.length);
const asFloats = (w: Uint32Array) => new Float32Array(w.buffer, w.byteOffset, w.length);

// Inclusive Hillis-Steele scan in f32, in the same order as the WGSL's.
function scanF32(a: Float32Array): void {
  for (let offset = 1; offset < 256; offset <<= 1) {
    const prev = Float32Array.from(a);
    for (let b = offset; b < 256; b++) a[b] = prev[b] + prev[b - offset];
  }
}

export const CPU_KERNELS: Record<string, CpuKernel> = {
  // Red, green, blue and luma histograms of the visible pixels, added to hist.
  histogram(a) {
    const src = a.words('src');
    const words = a.words('hist');
    const hist = asInts(words);
    const count = a.scalar('count');
    for (let p = 0; p < count; p++) {
      const v = src[p];
      if (v >>> 24 === 0) continue;
      hist[v & 255]++;
      hist[256 + ((v >>> 8) & 255)]++;
      hist[512 + ((v >>> 16) & 255)]++;
      hist[768 + lumaBin(v)]++;
    }
    a.store('hist', words);
  },

  // The luma histogram's normalised cumulative curve; lut[256] says
  // whether there's any spread at all.
  equalize_lut(a) {
    const hist = asInts(a.words('hist'));
    const words = a.words('lut');
    const lut = asFloats(words);
    const cdf = new Int32Array(256);
    let sum = 0;
    for (let b = 0; b < 256; b++) cdf[b] = sum += hist[768 + b];
    let lo = 0;
    for (let b = 0; b < 256; b++) {
      if (cdf[b] > 0) {
        lo = cdf[b];
        break;
      }
    }
    const total = cdf[255];
    const range = f(Math.max(total - lo, 1));
    for (let b = 0; b < 256; b++) lut[b] = Math.min(1, Math.max(0, f(f(cdf[b] - lo) / range)));
    lut[256] = total > lo ? 1 : 0;
    a.store('lut', words);
  },

  // Each channel's low and high levels, clipping a share of the pixels.
  auto_levels_params(a) {
    const hist = asInts(a.words('hist'));
    const words = a.words('params');
    const params = asFloats(words);
    const clip = a.scalar('clip');
    const linked = a.scalar('linked');
    for (let c = 0; c < Math.min(3, a.global[0]); c++) {
      const h0 = linked !== 0 ? 768 : c * 256;
      let count = 0;
      for (let b = 0; b < 256; b++) count += hist[h0 + b];
      const limit = Math.trunc(f(f(clip) * f(count)));
      let low = 0;
      let high = 255;
      let sum = 0;
      for (let b = 0; b < 256; b++) {
        sum += hist[h0 + b];
        if (sum > limit) {
          low = b;
          break;
        }
      }
      sum = 0;
      for (let b = 255; b >= 0; b--) {
        sum += hist[h0 + b];
        if (sum > limit) {
          high = b;
          break;
        }
      }
      if (high <= low) {
        low = 0;
        high = 255;
      }
      params[c * 2] = low / 255;
      params[c * 2 + 1] = high / 255;
    }
    a.store('params', words);
  },

  // A luma histogram for each of tiles_x x tiles_y tiles.
  clahe_hist(a) {
    const src = a.words('src');
    const words = a.words('hists');
    const hists = asInts(words);
    const width = a.scalar('width');
    const height = a.scalar('height');
    const tilesX = a.scalar('tiles_x');
    const tilesY = a.scalar('tiles_y');
    const tiles = Math.floor(a.global[0] / 256);
    for (let tile = 0; tile < tiles; tile++) {
      const tx = tile % tilesX;
      const ty = Math.trunc(tile / tilesX);
      const x0 = Math.trunc((tx * width) / tilesX);
      const x1 = Math.trunc(((tx + 1) * width) / tilesX);
      const y0 = Math.trunc((ty * height) / tilesY);
      const y1 = Math.trunc(((ty + 1) * height) / tilesY);
      const h = new Int32Array(256);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const v = src[y * width + x];
          if (v >>> 24 !== 0) h[lumaBin(v)]++;
        }
      }
      hists.set(h, tile * 256);
    }
    a.store('hists', words);
  },

  // Each tile's contrast-limited equalisation curve.
  clahe_lut(a) {
    const hists = asInts(a.words('hists'));
    const words = a.words('luts');
    const luts = asFloats(words);
    const clipLimit = a.scalar('clip_limit');
    const tiles = Math.floor(a.global[0] / 256);
    for (let tile = 0; tile < tiles; tile++) {
      let total = 0;
      for (let b = 0; b < 256; b++) total += hists[tile * 256 + b];
      const limit = Math.max(1, Math.trunc(f(f(f(clipLimit) * f(total)) / 256)));
      let excess = 0;
      for (let b = 0; b < 256; b++) excess += Math.max(hists[tile * 256 + b] - limit, 0);
      const curve = new Float32Array(256);
      const share = f(f(excess) / 256);
      for (let b = 0; b < 256; b++) curve[b] = f(Math.min(hists[tile * 256 + b], limit) + share);
      scanF32(curve);
      for (let b = 0; b < 256; b++) {
        luts[tile * 256 + b] = total !== 0 ? f(curve[b] / f(total)) : f(b / 255);
      }
    }
    a.store('luts', words);
  },

  // Plants each seed's number at its pixel.
  jfa_plant(a) {
    const seeds = asInts(a.words('seeds'));
    const words = a.words('cells');
    const cells = asInts(words);
    const width = a.scalar('width');
    const count = Math.min(a.scalar('count'), a.global[0]);
    for (let s = 0; s < count; s++) cells[seeds[2 * s + 1] * width + seeds[2 * s]] = s;
    a.store('cells', words);
  },

  // Sums each Voronoi cell's colour (times alpha), alpha and pixel count,
  // as 64-bit (low, high) word pairs, onto sums.
  cell_accumulate(a) {
    const src = a.words('src');
    const cells = asInts(a.words('cells'));
    const words = a.words('sums');
    const width = a.scalar('width');
    const height = Math.min(a.scalar('height'), a.global[1]);
    const w = Math.min(width, a.global[0]);
    // Cells can't have more than 2^53 / (255 * 255) pixels, so plain
    // numbers hold the sums exactly.
    const add = new Map<number, number[]>();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * width + x;
        const s = cells[i];
        if (s < 0) continue;
        let t = add.get(s);
        if (!t) add.set(s, (t = [0, 0, 0, 0, 0]));
        const v = src[i];
        const alpha = v >>> 24;
        if (alpha !== 0) {
          t[0] += (v & 255) * alpha;
          t[1] += ((v >>> 8) & 255) * alpha;
          t[2] += ((v >>> 16) & 255) * alpha;
          t[3] += alpha;
        }
        t[4]++;
      }
    }
    for (const [s, t] of add) {
      const cell = s * 9;
      for (let k = 0; k < 4; k++) {
        const total = words[cell + 2 * k] + words[cell + 2 * k + 1] * 4294967296 + t[k];
        words[cell + 2 * k] = total % 4294967296;
        words[cell + 2 * k + 1] = Math.floor(total / 4294967296);
      }
      words[cell + 8] = (words[cell + 8] + t[4]) >>> 0;
    }
    a.store('sums', words);
  },
};
