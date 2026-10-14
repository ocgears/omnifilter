'use strict';

// native/kernels/retro.cl and distort.cl.

const DISTORT_SAMPLE = 'sample_rgba_src';

exports.RETRO = {
  block_average: {
    args: 'src:in avg:f4out width:i32 height:i32 block:i32 blocks_x:i32 blocks_y:i32',
    guard: 'none',
    workgroup: [8, 8],
    body: `
  let bx = i32(gid.x);
  let by = i32(gid.y);
  if (bx >= blocks_x || by >= blocks_y) { return; }
  let x0 = bx * block;
  let y0 = by * block;
  let x1 = min(x0 + block, width);
  let y1 = min(y0 + block, height);
  var sum = vec4f(0.0);
  for (var y = y0; y < y1; y++) {
    for (var x = x0; x < x1; x++) {
      let p = vec4f(bytes4(src[y * width + x]));
      sum += vec4f(p.xyz * p.w, p.w);
    }
  }
  var o = vec4f(0.0);
  if (sum.w > 0.0) { o = vec4f(sum.xyz / sum.w, sum.w / f32((x1 - x0) * (y1 - y0))); }
  avg[by * blocks_x + bx] = o;`
  },

  pixelate_fill: {
    args: 'avg:f4s dst:out width:i32 height:i32 block:i32 blocks_x:i32',
    body: `
  let a = avg[(y / block) * blocks_x + x / block];
  dst[i] = pack_bytes(vec4u(sat_u8(a.x), sat_u8(a.y), sat_u8(a.z), sat_u8(a.w)));`
  },

  dither: {
    args: 'src:in dst:out width:i32 height:i32 levels:i32 pixel:i32 mode:i32',
    helpers: `
var<private> BAYER8: array<f32, 64> = array<f32, 64>(
   0, 32,  8, 40,  2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37,
  63, 31, 55, 23, 61, 29, 53, 21);`,
    body: `
  let bx = (x / pixel) & 7;
  let by = (y / pixel) & 7;
  let t = (BAYER8[by * 8 + bx] + 0.5) / 64.0 - 0.5;
  let c = to_rgb(src[i]);
  var o: vec3f;
  if (mode == 0) {
    let n = f32(levels - 1);
    o = clamp(floor(c * n + t + 0.5), vec3f(0.0), vec3f(n)) / n;
  } else if (mode == 1) {
    let n = f32(levels - 1);
    o = vec3f(clamp(floor(luma(c) * n + t + 0.5), 0.0, n) / n);
  } else {
    let shade = i32(clamp(floor(luma(c) * 3.0 + t + 0.5), 0.0, 3.0));
    if (shade == 0) { o = vec3f(0.059, 0.220, 0.059); }
    else if (shade == 1) { o = vec3f(0.188, 0.384, 0.188); }
    else if (shade == 2) { o = vec3f(0.545, 0.675, 0.059); }
    else { o = vec3f(0.608, 0.737, 0.059); }
  }
  dst[i] = from_rgb(o, alpha_of(src[i]));`
  },

  halftone: {
    args: 'src:img dst:out width:i32 height:i32 cell:f32 mono:i32 original:in',
    helpers: `
fn rgb_to_cmyk(c: vec3f) -> vec4f {
  let k = 1.0 - max(c.x, max(c.y, c.z));
  if (k >= 1.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  return vec4f((1.0 - c - k) / (1.0 - k), k);
}
fn halftone_ink(p: vec2f, angle: f32, cell: f32, channel: i32, w: i32, h: i32) -> f32 {
  let ca = cos(angle);
  let sa = sin(angle);
  let r = vec2f(ca * p.x + sa * p.y, -sa * p.x + ca * p.y);
  let base = floor(r / cell);
  var best = 0.0;
  for (var oy = -1; oy <= 1; oy++) {
    for (var ox = -1; ox <= 1; ox++) {
      let centre = (base + vec2f(f32(ox), f32(oy)) + 0.5) * cell;
      let image_pos = vec2f(ca * centre.x - sa * centre.y, sa * centre.x + ca * centre.y);
      let cmyk = rgb_to_cmyk(sample_rgba_src(image_pos, w, h).xyz);
      var ink = cmyk.w;
      if (channel == 0) { ink = cmyk.x; } else if (channel == 1) { ink = cmyk.y; } else if (channel == 2) { ink = cmyk.z; }
      let radius = sqrt(ink) * cell * 0.70710678;
      let d = length(r - centre);
      best = max(best, 1.0 - smoothstep(radius - 0.75, radius + 0.75, d));
    }
  }
  return best;
}`,
    body: `
  let p = vec2f(f32(x) + 0.5, f32(y) + 0.5);
  var o = vec3f(1.0);
  if (mono != 0) {
    let ca = 0.70710678;
    let r = vec2f(ca * (p.x + p.y), ca * (p.y - p.x));
    let base = floor(r / cell);
    var best = 0.0;
    for (var oy = -1; oy <= 1; oy++) {
      for (var ox = -1; ox <= 1; ox++) {
        let centre = (base + vec2f(f32(ox), f32(oy)) + 0.5) * cell;
        let image_pos = vec2f(ca * (centre.x - centre.y), ca * (centre.x + centre.y));
        let ink = 1.0 - luma(sample_rgba_src(image_pos, width, height).xyz);
        let radius = sqrt(ink) * cell * 0.70710678;
        best = max(best, 1.0 - smoothstep(radius - 0.75, radius + 0.75, length(r - centre)));
      }
    }
    o = vec3f(1.0 - best);
  } else {
    o.x *= 1.0 - halftone_ink(p, 15.0 * PI / 180.0, cell, 0, width, height);
    o.y *= 1.0 - halftone_ink(p, 75.0 * PI / 180.0, cell, 1, width, height);
    o.z *= 1.0 - halftone_ink(p, 0.0, cell, 2, width, height);
    o *= 1.0 - halftone_ink(p, 45.0 * PI / 180.0, cell, 3, width, height);
  }
  dst[i] = from_rgb(o, alpha_of(original[i]));`
  },

  ascii_art: {
    args: 'avg:f4s glyphs:bytes dst:out width:i32 height:i32 cell:i32 blocks_x:i32 glyph_count:i32 mode:i32',
    body: `
  let tile = avg[(y / cell) * blocks_x + x / cell];
  let c = tile.xyz / 255.0;
  let l = luma(c);
  var density = l;
  if (mode == 2) { density = 1.0 - l; }
  let g = min(i32(density * f32(glyph_count)), glyph_count - 1);
  let u = (x % cell) * 8 / cell;
  let v = (y % cell) * 8 / cell;
  let on = (byte_glyphs(g * 8 + v) >> u32(7 - u)) & 1u;
  var o: vec3f;
  if (mode == 0) {
    let peak = max(c.x, max(c.y, c.z));
    o = select(vec3f(0.0), c / max(peak, 0.05), on != 0u);
  } else if (mode == 1) {
    o = select(vec3f(0.0, 0.04, 0.0), vec3f(0.25, 1.0, 0.35), on != 0u);
  } else {
    o = select(vec3f(0.98, 0.97, 0.94), vec3f(0.08), on != 0u);
  }
  dst[i] = from_rgb(o, sat_u8(tile.w));`
  },

  swirl: {
    args: 'src:img dst:out width:i32 height:i32 cx:f32 cy:f32 radius:f32 angle:f32',
    body: `
  let c = vec2f(cx * f32(width), cy * f32(height));
  let d = vec2f(f32(x) + 0.5, f32(y) + 0.5) - c;
  let dist = length(d);
  var p = c + d;
  if (dist < radius) {
    let t = 1.0 - dist / radius;
    let theta = angle * t * t;
    let cs = cos(theta);
    let sn = sin(theta);
    p = c + vec2f(cs * d.x - sn * d.y, sn * d.x + cs * d.y);
  }
  dst[i] = from_rgba(${DISTORT_SAMPLE}(p, width, height));`
  },

  pinch_bulge: {
    args: 'src:img dst:out width:i32 height:i32 cx:f32 cy:f32 radius:f32 amount:f32',
    body: `
  let c = vec2f(cx * f32(width), cy * f32(height));
  let d = vec2f(f32(x) + 0.5, f32(y) + 0.5) - c;
  let dist = length(d);
  var p = c + d;
  if (dist < radius && dist > 0.0) {
    let rn = dist / radius;
    p = c + d * (pow(rn, 1.0 + amount) / rn);
  }
  dst[i] = from_rgba(${DISTORT_SAMPLE}(p, width, height));`
  },

  fisheye: {
    args: 'src:img dst:out width:i32 height:i32 fov:f32',
    body: `
  let c = vec2f(f32(width) * 0.5, f32(height) * 0.5);
  let d = vec2f(f32(x) + 0.5, f32(y) + 0.5) - c;
  let max_r = length(c);
  let rn = length(d) / max_r;
  var p = c + d;
  if (rn > 0.0) {
    let src_rn = tan(rn * fov * 0.5) / tan(fov * 0.5);
    p = c + d * (src_rn / rn);
  }
  dst[i] = from_rgba(${DISTORT_SAMPLE}(p, width, height));`
  },

  ripple: {
    args: 'src:img dst:out width:i32 height:i32 amplitude:f32 wavelength:f32 mode:i32',
    body: `
  let q = vec2f(f32(x) + 0.5, f32(y) + 0.5);
  var p: vec2f;
  if (mode == 0) {
    let c = vec2f(f32(width) * 0.5, f32(height) * 0.5);
    let d = q - c;
    let dist = length(d);
    let offset = amplitude * sin(2.0 * PI * dist / wavelength);
    p = q;
    if (dist > 0.0) { p = q + d / dist * offset; }
  } else {
    p = q + amplitude * vec2f(sin(2.0 * PI * q.y / wavelength), sin(2.0 * PI * q.x / wavelength));
  }
  dst[i] = from_rgba(${DISTORT_SAMPLE}(p, width, height));`
  },

  lens_distortion: {
    args: 'src:img dst:out width:i32 height:i32 amount:f32',
    body: `
  let c = vec2f(f32(width) * 0.5, f32(height) * 0.5);
  let d = vec2f(f32(x) + 0.5, f32(y) + 0.5) - c;
  let r2 = dot(d, d) / dot(c, c);
  let factor = (1.0 + amount * r2) / (1.0 + max(amount, 0.0));
  dst[i] = from_rgba(${DISTORT_SAMPLE}(c + d * factor, width, height));`
  },

  chromatic_aberration: {
    args: 'src:img dst:out width:i32 height:i32 amount:f32',
    body: `
  let c = vec2f(f32(width) * 0.5, f32(height) * 0.5);
  let d = vec2f(f32(x) + 0.5, f32(y) + 0.5) - c;
  let g = ${DISTORT_SAMPLE}(c + d, width, height);
  let r = ${DISTORT_SAMPLE}(c + d * (1.0 + amount), width, height).x;
  let b = ${DISTORT_SAMPLE}(c + d * (1.0 - amount), width, height).z;
  dst[i] = from_rgba(vec4f(r, g.y, b, g.w));`
  }
};
