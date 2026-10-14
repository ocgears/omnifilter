// native/kernels/colour.cl and blend.cl.
import { KernelSpec } from '../kernel';

export const COLOUR: Record<string, KernelSpec> = {
  color_matrix: {
    args: 'src:in dst:out width:i32 height:i32 m:f32s',
    body: `
  let c = px(src[i]);
  let o = vec4f(
    m[0] * c.x + m[1] * c.y + m[2] * c.z + m[3] * c.w + m[4],
    m[5] * c.x + m[6] * c.y + m[7] * c.z + m[8] * c.w + m[9],
    m[10] * c.x + m[11] * c.y + m[12] * c.z + m[13] * c.w + m[14],
    m[15] * c.x + m[16] * c.y + m[17] * c.z + m[18] * c.w + m[19]);
  dst[i] = from_rgba(o);`,
  },

  gamma_correct: {
    args: 'src:in dst:out width:i32 height:i32 gamma:f32',
    body: `
  dst[i] = from_rgb(pow(to_rgb(src[i]), vec3f(1.0 / gamma)), alpha_of(src[i]));`,
  },

  threshold: {
    args: 'src:in dst:out width:i32 height:i32 level:f32',
    body: `
  let v = select(0.0, 1.0, luma(to_rgb(src[i])) >= level);
  dst[i] = from_rgb(vec3f(v), alpha_of(src[i]));`,
  },

  posterize: {
    args: 'src:in dst:out width:i32 height:i32 levels:i32',
    body: `
  let n = f32(levels - 1);
  dst[i] = from_rgb(round(to_rgb(src[i]) * n) / n, alpha_of(src[i]));`,
  },

  solarize: {
    args: 'src:in dst:out width:i32 height:i32 level:f32',
    body: `
  let c = to_rgb(src[i]);
  dst[i] = from_rgb(select(c, 1.0 - c, c > vec3f(level)), alpha_of(src[i]));`,
  },

  duotone: {
    args: 'src:in dst:out width:i32 height:i32 sr:f32 sg:f32 sb:f32 hr:f32 hg:f32 hb:f32',
    body: `
  let l = luma(to_rgb(src[i]));
  dst[i] = from_rgb(mix(vec3f(sr, sg, sb), vec3f(hr, hg, hb), l), alpha_of(src[i]));`,
  },

  vignette: {
    args: 'src:in dst:out width:i32 height:i32 strength:f32 radius:f32 softness:f32',
    body: `
  let d = vec2f(f32(x) + 0.5 - f32(width) * 0.5, f32(y) + 0.5 - f32(height) * 0.5);
  let dist = length(d) / (0.5 * sqrt(f32(width) * f32(width) + f32(height) * f32(height)));
  let f = 1.0 - strength * smoothstep(radius, radius + softness, dist);
  dst[i] = from_rgb(to_rgb(src[i]) * f, alpha_of(src[i]));`,
  },

  // A 3D image (OpenCL image3d_t) read with the LINEAR sampler: a buffer of
  // size^3 RGBA floats, red fastest, interpolated trilinearly here.
  lut3d: {
    args: 'src:in dst:out width:i32 height:i32 lut:f4s size:i32 amount:f32 domain:f32s',
    helpers: `
fn lut_at(r: i32, g: i32, b: i32, size: i32) -> vec4f {
  return lut[(clamp(b, 0, size - 1) * size + clamp(g, 0, size - 1)) * size + clamp(r, 0, size - 1)];
}`,
    body: `
  let c = to_rgb(src[i]);
  let lo = vec3f(domain[0], domain[1], domain[2]);
  let hi = vec3f(domain[3], domain[4], domain[5]);
  let coord = clamp((c - lo) / (hi - lo), vec3f(0.0), vec3f(1.0)) * f32(size - 1) + 0.5;
  let q = coord - 0.5;
  let f = floor(q);
  let t = q - f;
  let p = vec3i(f);
  let c00 = mix(lut_at(p.x, p.y, p.z, size), lut_at(p.x + 1, p.y, p.z, size), t.x);
  let c10 = mix(lut_at(p.x, p.y + 1, p.z, size), lut_at(p.x + 1, p.y + 1, p.z, size), t.x);
  let c01 = mix(lut_at(p.x, p.y, p.z + 1, size), lut_at(p.x + 1, p.y, p.z + 1, size), t.x);
  let c11 = mix(lut_at(p.x, p.y + 1, p.z + 1, size), lut_at(p.x + 1, p.y + 1, p.z + 1, size), t.x);
  let graded = mix(mix(c00, c10, t.y), mix(c01, c11, t.y), t.z);
  dst[i] = from_rgb(mix(c, graded.xyz, amount), alpha_of(src[i]));`,
  },

  blend_layers: {
    args: 'src:in dst:out width:i32 height:i32 base:in mode:i32 amount:f32',
    helpers: `
fn blend_lum(c: vec3f) -> f32 {
  return dot(c, vec3f(0.3, 0.59, 0.11));
}
fn blend_clip(c0: vec3f) -> vec3f {
  var c = c0;
  let l = blend_lum(c);
  let n = min(c.x, min(c.y, c.z));
  let x = max(c.x, max(c.y, c.z));
  if (n < 0.0) { c = l + (c - l) * l / (l - n); }
  if (x > 1.0) { c = l + (c - l) * (1.0 - l) / (x - l); }
  return c;
}
fn blend_set_lum(c: vec3f, l: f32) -> vec3f {
  return blend_clip(c + (l - blend_lum(c)));
}
fn soft_light(b: vec3f, t: vec3f) -> vec3f {
  let d = select(sqrt(b), ((16.0 * b - 12.0) * b + 4.0) * b, b < vec3f(0.25));
  return select(b + (2.0 * t - 1.0) * (d - b), b - (1.0 - 2.0 * t) * b * (1.0 - b), t <= vec3f(0.5));
}
fn blend_rgb(b: vec3f, t: vec3f, mode: i32) -> vec3f {
  switch (mode) {
    case 1: { return b * t; }
    case 2: { return b + t - b * t; }
    case 3: { return select(1.0 - 2.0 * (1.0 - b) * (1.0 - t), 2.0 * b * t, b < vec3f(0.5)); }
    case 4: { return soft_light(b, t); }
    case 5: { return min(b, t); }
    case 6: { return max(b, t); }
    case 7: { return abs(b - t); }
    case 8: { return blend_set_lum(t, blend_lum(b)); }
    case 9: { return blend_set_lum(b, blend_lum(t)); }
    default: { return t; }
  }
}`,
    body: `
  let t = px(src[i]);
  let b = px(base[i]);
  let blended = mix(t.xyz, blend_rgb(b.xyz, t.xyz, mode), b.w);
  let layer = premultiply(vec4f(blended, t.w));
  dst[i] = from_rgba(unpremultiply(mix(premultiply(b), layer, amount)));`,
  },
};
