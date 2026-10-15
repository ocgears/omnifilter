'use strict';

// Plain JavaScript versions of OpenCL kernels in native/kernels/, used by the
// tests to check the GPU's output pixel by pixel. They favour clarity over
// speed. Images are RGBA byte arrays, with straight (non-premultiplied) alpha.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const toByte = (v) => clamp(Math.round(v * 255), 0, 255);
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

// Builds an image by calling fn(x, y, offset) -> [r, g, b, a] for each pixel.
function map(src, width, height, fn) {
  const dst = new Uint8Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      dst.set(fn(x, y, o), o);
    }
  }
  return dst;
}

// Offset of a pixel, clamping coordinates to the image.
const at = (width, height, x, y) => (clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)) * 4;
const rgb = (src, o) => [src[o] / 255, src[o + 1] / 255, src[o + 2] / 255];

// Premultiplied RGBA from 0 to 1, and back to straight bytes.
const premul = (src, o) => {
  const a = src[o + 3] / 255;
  return [src[o] / 255 * a, src[o + 1] / 255 * a, src[o + 2] / 255 * a, a];
};
const unpremulBytes = (c) => (c[3] > 0 ? [c[0] / c[3], c[1] / c[3], c[2] / c[3], c[3]] : [0, 0, 0, 0]).map(toByte);

// With premultiply, colour times alpha and alpha are filtered together;
// otherwise alpha is kept and each neighbour's colour is mixed towards the
// centre pixel's by its transparency.
exports.convolve = (src, width, height, weights, kw, kh, bias, absolute, premultiply) =>
  map(src, width, height, (x, y, o) => {
    const acc = [0, 0, 0, 0];
    for (let j = 0; j < kh; j++) {
      for (let k = 0; k < kw; k++) {
        const s = at(width, height, x + k - (kw >> 1), y + j - (kh >> 1));
        const w = weights[j * kw + k];
        const a = src[s + 3] / 255;
        for (let c = 0; c < 3; c++) {
          acc[c] += (premultiply ? src[s + c] * a : src[o + c] + (src[s + c] - src[o + c]) * a) * w;
        }
        acc[3] += src[s + 3] * w;
      }
    }
    const v = acc.map((n) => (absolute ? Math.abs(n) : n));
    const round = (n) => clamp(Math.round(n), 0, 255);
    if (!premultiply) return v.slice(0, 3).map((n) => round(n + bias)).concat(src[o + 3]);
    return v.slice(0, 3).map((n) => round((v[3] > 0 ? n * 255 / v[3] : 0) + bias)).concat(round(v[3]));
  });

exports.colorMatrix = (src, width, height, m) =>
  map(src, width, height, (x, y, o) => {
    const c = [src[o] / 255, src[o + 1] / 255, src[o + 2] / 255, src[o + 3] / 255];
    return [0, 1, 2, 3].map((r) =>
      toByte(m[r * 5] * c[0] + m[r * 5 + 1] * c[1] + m[r * 5 + 2] * c[2] + m[r * 5 + 3] * c[3] + m[r * 5 + 4]));
  });

const point = (fn) => (src, width, height, arg) =>
  map(src, width, height, (x, y, o) => fn(rgb(src, o), arg).map(toByte).concat(src[o + 3]));

exports.gamma = point((c, g) => c.map((v) => Math.pow(v, 1 / g)));
exports.threshold = point((c, level) => {
  const v = luma(c) >= level ? 1 : 0;
  return [v, v, v];
});
exports.posterize = point((c, levels) => c.map((v) => Math.round(v * (levels - 1)) / (levels - 1)));
exports.solarize = point((c, level) => c.map((v) => (v > level ? 1 - v : v)));

exports.sobel = (src, width, height, scale, mode) =>
  map(src, width, height, (x, y, o) => {
    const l = (dx, dy) => luma(rgb(src, at(width, height, x + dx, y + dy)));
    const gx = (l(1, -1) + 2 * l(1, 0) + l(1, 1)) - (l(-1, -1) + 2 * l(-1, 0) + l(-1, 1));
    const gy = (l(-1, 1) + 2 * l(0, 1) + l(1, 1)) - (l(-1, -1) + 2 * l(0, -1) + l(1, -1));
    const mag = clamp(Math.sqrt(gx * gx + gy * gy) * scale, 0, 1);
    const v = toByte(mode === 0 ? mag : 1 - mag);
    return [v, v, v, src[o + 3]];
  });

// Fully transparent pixels are left out of the colour channels' medians.
exports.median = (src, width, height, radius) =>
  map(src, width, height, (x, y) => {
    const out = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
      const values = [];
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const s = at(width, height, x + dx, y + dy);
          if (c === 3 || src[s + 3] > 0) values.push(src[s + c]);
        }
      }
      // No visible pixels in the window at all: transparent black.
      if (!values.length) return [0, 0, 0, 0];
      values.sort((a, b) => a - b);
      out[c] = values[Math.floor(values.length / 2)];
    }
    return out;
  });

// Premultiplied, with alpha in the variance.
exports.kuwahara = (src, width, height, radius) =>
  map(src, width, height, (x, y) => {
    const quadrants = [[-radius, 0, -radius, 0], [0, radius, -radius, 0], [-radius, 0, 0, radius], [0, radius, 0, radius]];
    let best = Infinity;
    let out = null;
    for (const [x0, x1, y0, y1] of quadrants) {
      const sum = [0, 0, 0, 0];
      const sum2 = [0, 0, 0, 0];
      for (let dy = y0; dy <= y1; dy++) {
        for (let dx = x0; dx <= x1; dx++) {
          const c = premul(src, at(width, height, x + dx, y + dy));
          for (let k = 0; k < 4; k++) {
            sum[k] += c[k];
            sum2[k] += c[k] * c[k];
          }
        }
      }
      const n = (radius + 1) * (radius + 1);
      const mean = sum.map((s) => s / n);
      const v = sum2.reduce((acc, s, k) => acc + s / n - mean[k] * mean[k], 0);
      if (v < best) {
        best = v;
        out = mean;
      }
    }
    return unpremulBytes(out);
  });

// Premultiplied, with alpha in the colour distance.
exports.bilateral = (src, width, height, radius, sigmaS, sigmaR) =>
  map(src, width, height, (x, y, o) => {
    const c0 = premul(src, o);
    const sum = [0, 0, 0, 0];
    let wsum = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const c = premul(src, at(width, height, x + dx, y + dy));
        const d2 = c.reduce((acc, v, k) => acc + (v - c0[k]) ** 2, 0);
        const w = Math.exp(-(dx * dx + dy * dy) / (2 * sigmaS * sigmaS) - d2 / (2 * sigmaR * sigmaR));
        for (let k = 0; k < 4; k++) sum[k] += c[k] * w;
        wsum += w;
      }
    }
    return unpremulBytes(sum.map((s) => s / wsum));
  });

// Block averages, premultiplied: the visible pixels' mean colour, with the
// block's mean alpha.
exports.pixelate = (src, width, height, block) =>
  map(src, width, height, (x, y) => {
    const x0 = Math.floor(x / block) * block;
    const y0 = Math.floor(y / block) * block;
    const sum = [0, 0, 0, 0];
    let n = 0;
    for (let yy = y0; yy < Math.min(y0 + block, height); yy++) {
      for (let xx = x0; xx < Math.min(x0 + block, width); xx++) {
        const o = (yy * width + xx) * 4;
        for (let c = 0; c < 3; c++) sum[c] += src[o + c] * src[o + 3];
        sum[3] += src[o + 3];
        n++;
      }
    }
    if (!sum[3]) return [0, 0, 0, 0];
    return [sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3], sum[3] / n].map((v) => clamp(Math.round(v), 0, 255));
  });

const lumaBin = (src, o) => clamp(Math.floor(0.2126 * src[o] + 0.7152 * src[o + 1] + 0.0722 * src[o + 2] + 0.5), 0, 255);

function withLuma(c, y2) {
  const y = luma(c);
  const cb = (c[2] - y) / 1.8556;
  const cr = (c[0] - y) / 1.5748;
  const r = y2 + 1.5748 * cr;
  const b = y2 + 1.8556 * cb;
  return [r, (y2 - 0.2126 * r - 0.0722 * b) / 0.7152, b];
}

// Histograms leave out fully transparent pixels.
exports.equalize = (src, width, height, amount) => {
  const hist = new Array(256).fill(0);
  for (let o = 0; o < src.length; o += 4) if (src[o + 3]) hist[lumaBin(src, o)]++;
  const cdf = [];
  hist.reduce((acc, h, i) => (cdf[i] = acc + h), 0);
  const cdfMin = cdf.find((v) => v > 0) || 0;
  const count = cdf[255];
  // One luma level (or none): nothing to spread, so the image is unchanged.
  if (count === cdfMin) amount = 0;
  const lut = cdf.map((v) => clamp((v - cdfMin) / Math.max(count - cdfMin, 1), 0, 1));
  return map(src, width, height, (x, y, o) => {
    const c = rgb(src, o);
    const e = withLuma(c, lut[lumaBin(src, o)]);
    return c.map((v, k) => toByte(v + (e[k] - v) * amount)).concat(src[o + 3]);
  });
};

exports.autoLevels = (src, width, height, clip, linked) => {
  const hist = [0, 1, 2, 3].map(() => new Array(256).fill(0));
  let count = 0;
  for (let o = 0; o < src.length; o += 4) {
    if (!src[o + 3]) continue;
    for (let c = 0; c < 3; c++) hist[c][src[o + c]]++;
    hist[3][lumaBin(src, o)]++;
    count++;
  }
  const limit = Math.floor(clip * count);
  const ranges = [0, 1, 2].map((c) => {
    const h = hist[linked ? 3 : c];
    let low = 0;
    let high = 255;
    let sum = 0;
    for (let b = 0; b < 256; b++) if ((sum += h[b]) > limit) { low = b; break; }
    sum = 0;
    for (let b = 255; b >= 0; b--) if ((sum += h[b]) > limit) { high = b; break; }
    return high <= low ? [0, 1] : [low / 255, high / 255];
  });
  return map(src, width, height, (x, y, o) =>
    rgb(src, o).map((v, c) => toByte((v - ranges[c][0]) / (ranges[c][1] - ranges[c][0]))).concat(src[o + 3]));
};

// Layer blending, from the W3C Compositing and Blending spec: top over base
// with a blend mode, faded by amount (0-1).
const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
function clipColor(c) {
  const l = lum(c);
  const n = Math.min.apply(null, c);
  const x = Math.max.apply(null, c);
  if (n < 0) c = c.map((v) => l + (v - l) * l / (l - n));
  if (x > 1) c = c.map((v) => l + (v - l) * (1 - l) / (x - l));
  return c;
}
const setLum = (c, l) => clipColor(c.map((v) => v + l - lum(c)));
const separable = (fn) => (b, t) => b.map((v, i) => fn(v, t[i]));
const BLEND_FUNCTIONS = {
  normal: (b, t) => t,
  multiply: separable((b, t) => b * t),
  screen: separable((b, t) => b + t - b * t),
  overlay: separable((b, t) => (b < 0.5 ? 2 * b * t : 1 - 2 * (1 - b) * (1 - t))),
  soft_light: separable((b, t) => {
    if (t <= 0.5) return b - (1 - 2 * t) * b * (1 - b);
    const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
    return b + (2 * t - 1) * (d - b);
  }),
  darken: separable(Math.min),
  lighten: separable(Math.max),
  difference: separable((b, t) => Math.abs(b - t)),
  color: (b, t) => setLum(t, lum(b)),
  luminosity: (b, t) => setLum(b, lum(t))
};

// Where the base is transparent the layer keeps its own colour (the spec's
// Cs' = (1 - ab) Cs + ab B(Cb, Cs)); amount fades from the base to that
// layer, premultiplied.
exports.blend = (top, base, mode, amount) => {
  const out = new Uint8Array(top.length);
  for (let o = 0; o < top.length; o += 4) {
    const b = rgb(base, o);
    const t = rgb(top, o);
    const ab = base[o + 3] / 255;
    const at = top[o + 3] / 255;
    const blended = BLEND_FUNCTIONS[mode](b, t).map((v, c) => (1 - ab) * t[c] + ab * v);
    const mixed = [0, 1, 2].map((c) => b[c] * ab + (blended[c] * at - b[c] * ab) * amount)
      .concat(ab + (at - ab) * amount);
    out.set(unpremulBytes(mixed), o);
  }
  return out;
};

// The image with fully transparent pixels' hidden colour cleared, for
// comparing images where only the visible colours matter.
exports.visible = (img) => {
  const out = Uint8Array.from(img);
  for (let o = 0; o < out.length; o += 4) if (!out[o + 3]) out.fill(0, o, o + 3);
  return out;
};

// Largest absolute difference between two byte arrays, and how many differ.
exports.compare = (a, b) => {
  let max = 0;
  let count = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
    if (d) count++;
  }
  return { max: max, count: count };
};

exports.randomImage = (width, height, seed) => {
  let s = seed || 1;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    data[i] = s >> 23;
  }
  return data;
};
