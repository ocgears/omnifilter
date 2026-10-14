// native/kernels/convolve.cl.
import { KernelSpec } from '../kernel';

export const CONVOLVE: Record<string, KernelSpec> = {
  convolve: {
    args: 'src:in dst:out width:i32 height:i32 weights:f32s kw:i32 kh:i32 bias:f32 absolute:i32 premul:i32 row0:i32',
    guard: 'band',
    body: `
  let rx = kw / 2;
  let ry = kh / 2;
  if (premul != 0) {
    // Colour in 0-255 times alpha in 0-1, and alpha in 0-255.
    var acc = vec4f(0.0);
    for (var j = 0; j < kh; j++) {
      let sy = clamp(y + j - ry, 0, height - 1);
      for (var k = 0; k < kw; k++) {
        let sx = clamp(x + k - rx, 0, width - 1);
        let p = vec4f(bytes4(src[sy * width + sx]));
        acc += vec4f(p.xyz * (p.w * (1.0 / 255.0)), p.w) * weights[j * kw + k];
      }
    }
    if (absolute != 0) { acc = abs(acc); }
    var c = vec3f(0.0);
    if (acc.w > 0.0) { c = acc.xyz * (255.0 / acc.w); }
    let o = c + bias;
    dst[i] = pack_bytes(vec4u(sat_u8(o.x), sat_u8(o.y), sat_u8(o.z), sat_u8(acc.w)));
    return;
  }
  let c0 = vec3f(bytes4(src[i]).xyz);
  var acc3 = vec3f(0.0);
  for (var j = 0; j < kh; j++) {
    let sy = clamp(y + j - ry, 0, height - 1);
    for (var k = 0; k < kw; k++) {
      let sx = clamp(x + k - rx, 0, width - 1);
      let p = vec4f(bytes4(src[sy * width + sx]));
      acc3 += mix(c0, p.xyz, p.w * (1.0 / 255.0)) * weights[j * kw + k];
    }
  }
  if (absolute != 0) { acc3 = abs(acc3); }
  acc3 += bias;
  dst[i] = pack_bytes(vec4u(sat_u8(acc3.x), sat_u8(acc3.y), sat_u8(acc3.z), alpha_of(src[i])));`,
  },

  downsample_box: {
    args: 'src:in dst:out width:i32 height:i32 small_width:i32 small_height:i32 factor:i32',
    guard: 'none',
    workgroup: [8, 8],
    body: `
  let sx = i32(gid.x);
  let sy = i32(gid.y);
  if (sx >= small_width || sy >= small_height) { return; }
  let x0 = sx * factor;
  let y0 = sy * factor;
  let x1 = min(x0 + factor, width);
  let y1 = min(y0 + factor, height);
  var sum = vec4f(0.0);
  for (var y = y0; y < y1; y++) {
    for (var x = x0; x < x1; x++) { sum += premul_pixel(src[y * width + x]); }
  }
  dst[sy * small_width + sx] = from_rgba(unpremultiply(sum / f32((x1 - x0) * (y1 - y0))));`,
  },

  upsample_bilinear: {
    args: 'small:in dst:out width:i32 height:i32 small_width:i32 small_height:i32 factor:i32',
    body: `
  let q = vec2f(f32(x) + 0.5, f32(y) + 0.5) / f32(factor) - 0.5;
  let f = floor(q);
  let t = q - f;
  let x0 = clamp(i32(f.x), 0, small_width - 1);
  let y0 = clamp(i32(f.y), 0, small_height - 1);
  let x1 = clamp(i32(f.x) + 1, 0, small_width - 1);
  let y1 = clamp(i32(f.y) + 1, 0, small_height - 1);
  let a = premul_pixel(small[y0 * small_width + x0]);
  let b = premul_pixel(small[y0 * small_width + x1]);
  let c = premul_pixel(small[y1 * small_width + x0]);
  let d = premul_pixel(small[y1 * small_width + x1]);
  dst[i] = from_rgba(unpremultiply(mix(mix(a, b, t.x), mix(c, d, t.x), t.y)));`,
  },

  convolve_f4: {
    args: 'src:f4s dst:f4out width:i32 height:i32 weights:f32s kw:i32 kh:i32',
    body: `
  let rx = kw / 2;
  let ry = kh / 2;
  var acc = vec4f(0.0);
  for (var j = 0; j < kh; j++) {
    let sy = clamp(y + j - ry, 0, height - 1);
    for (var k = 0; k < kw; k++) {
      let sx = clamp(x + k - rx, 0, width - 1);
      acc += src[sy * width + sx] * weights[j * kw + k];
    }
  }
  dst[i] = acc;`,
  },

  restore_alpha: {
    args: 'src:in dst:out width:i32 height:i32 original:in',
    body: `
  dst[i] = (src[i] & 0x00ffffffu) | (original[i] & 0xff000000u);`,
  },

  unsharp: {
    args: 'src:in blurred:in dst:out width:i32 height:i32 amount:f32 threshold:f32',
    body: `
  let s = to_rgb(src[i]);
  let diff = s - to_rgb(blurred[i]);
  var mask = 1.0;
  if (threshold > 0.0) { mask = smoothstep(threshold * 0.5, threshold, abs(luma(diff))); }
  dst[i] = from_rgb(s + amount * mask * diff, alpha_of(src[i]));`,
  },

  motion_blur: {
    args: 'src:img dst:out width:i32 height:i32 dx:f32 dy:f32 samples:i32 row0:i32',
    guard: 'band',
    body: `
  let p = vec2f(f32(x) + 0.5, f32(y) + 0.5);
  let d = vec2f(dx, dy);
  var acc = vec4f(0.0);
  for (var s = 0; s < samples; s++) {
    var t = 0.0;
    if (samples > 1) { t = f32(s) / f32(samples - 1) - 0.5; }
    acc += sample_premul_src(p + t * d, width, height);
  }
  dst[i] = from_rgba(unpremultiply(acc / f32(samples)));`,
  },

  tilt_shift: {
    args: 'src:in blur1:in blur2:in dst:out width:i32 height:i32 focus:f32 band:f32 transition:f32 saturation:f32',
    body: `
  let ny = (f32(y) + 0.5) / f32(height);
  let m = smoothstep(0.0, 1.0, clamp((abs(ny - focus) - band) / transition, 0.0, 1.0));
  let s = premul_pixel(src[i]);
  let b1 = premul_pixel(blur1[i]);
  let b2 = premul_pixel(blur2[i]);
  var c: vec4f;
  if (m < 0.5) { c = unpremultiply(mix(s, b1, m * 2.0)); } else { c = unpremultiply(mix(b1, b2, m * 2.0 - 1.0)); }
  let l = luma(c.xyz);
  dst[i] = from_rgba(vec4f(l + (c.xyz - l) * saturation, c.w));`,
  },
};
