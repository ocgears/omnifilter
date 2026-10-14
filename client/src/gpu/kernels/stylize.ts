// native/kernels/stylize.cl.
import { KernelSpec } from '../kernel';

export const STYLIZE: Record<string, KernelSpec> = {
  sobel: {
    args: 'src:in dst:out width:i32 height:i32 scale:f32 mode:i32',
    body: `
  let tl = luma(rgb_at_src(x - 1, y - 1, width, height));
  let t = luma(rgb_at_src(x, y - 1, width, height));
  let tr = luma(rgb_at_src(x + 1, y - 1, width, height));
  let l = luma(rgb_at_src(x - 1, y, width, height));
  let r = luma(rgb_at_src(x + 1, y, width, height));
  let bl = luma(rgb_at_src(x - 1, y + 1, width, height));
  let b = luma(rgb_at_src(x, y + 1, width, height));
  let br = luma(rgb_at_src(x + 1, y + 1, width, height));
  let gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
  let gy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);
  let mag = clamp(sqrt(gx * gx + gy * gy) * scale, 0.0, 1.0);
  var o: vec3f;
  if (mode == 0) { o = vec3f(mag); }
  else if (mode == 1) { o = vec3f(1.0 - mag); }
  else { o = hsv_to_rgb(atan2(gy, gx) / (2.0 * PI) + 0.5, 1.0, mag); }
  dst[i] = from_rgb(o, alpha_of(src[i]));`,
  },

  color_dodge: {
    args: 'base:in layer:in dst:out width:i32 height:i32',
    body: `
  let b = to_rgb(base[i]);
  let l = to_rgb(layer[i]);
  dst[i] = from_rgb(min(b / max(1.0 - l, vec3f(1e-3)), vec3f(1.0)), alpha_of(base[i]));`,
  },

  bilateral: {
    args: 'src:in dst:out width:i32 height:i32 radius:i32 sigma_s:f32 sigma_r:f32 row0:i32',
    guard: 'band',
    body: `
  let c0 = premul_pixel(src[i]);
  let ks = -0.5 / (sigma_s * sigma_s);
  let kr = -0.5 / (sigma_r * sigma_r);
  var sum = vec4f(0.0);
  var wsum = 0.0;
  for (var dy = -radius; dy <= radius; dy++) {
    for (var dx = -radius; dx <= radius; dx++) {
      let c = premul_pixel(at_src(x + dx, y + dy, width, height));
      let d = c - c0;
      let w = exp(f32(dx * dx + dy * dy) * ks + dot(d, d) * kr);
      sum += c * w;
      wsum += w;
    }
  }
  dst[i] = from_rgba(unpremultiply(sum / wsum));`,
  },

  quantize_luma: {
    args: 'src:in dst:out width:i32 height:i32 levels:i32 sharpness:f32',
    body: `
  let c = to_rgb(src[i]);
  let l = luma(c);
  let band = 1.0 / f32(levels);
  let nearest = band * round(l / band);
  let q = nearest + 0.5 * band * tanh(sharpness * (l - nearest) / band);
  dst[i] = from_rgb(with_luma(c, q), alpha_of(src[i]));`,
  },

  dog_lines: {
    args: 'narrow:in wide:in dst:out width:i32 height:i32 threshold:f32 sharpness:f32',
    body: `
  let d = luma(to_rgb(narrow[i])) - luma(to_rgb(wide[i]));
  let ink = clamp((-d - threshold) * sharpness, 0.0, 1.0);
  dst[i] = from_rgb(vec3f(ink), 255u);`,
  },

  cartoon_combine: {
    args: 'colour:in ink:in dst:out width:i32 height:i32',
    body: `
  let k = f32(bytes4(ink[i]).x) / 255.0;
  dst[i] = from_rgb(to_rgb(colour[i]) * (1.0 - k), alpha_of(colour[i]));`,
  },

  kuwahara: {
    args: 'src:in dst:out width:i32 height:i32 radius:i32 row0:i32',
    guard: 'band',
    body: `
  var sum: array<vec4f, 4>;
  var sum2: array<vec4f, 4>;
  for (var dy = -radius; dy <= radius; dy++) {
    for (var dx = -radius; dx <= radius; dx++) {
      let c = premul_pixel(at_src(x + dx, y + dy, width, height));
      let c2 = c * c;
      if (dx <= 0 && dy <= 0) { sum[0] += c; sum2[0] += c2; }
      if (dx >= 0 && dy <= 0) { sum[1] += c; sum2[1] += c2; }
      if (dx <= 0 && dy >= 0) { sum[2] += c; sum2[2] += c2; }
      if (dx >= 0 && dy >= 0) { sum[3] += c; sum2[3] += c2; }
    }
  }
  let n = f32((radius + 1) * (radius + 1));
  var best = MAXFLOAT;
  var out = vec4f(0.0);
  for (var q = 0; q < 4; q++) {
    let mean = sum[q] / n;
    let v4 = sum2[q] / n - mean * mean;
    let v = v4.x + v4.y + v4.z + v4.w;
    if (v < best) {
      best = v;
      out = mean;
    }
  }
  dst[i] = from_rgba(unpremultiply(out));`,
  },

  median: {
    args: 'src:in dst:out width:i32 height:i32 radius:i32 row0:i32',
    guard: 'band',
    body: `
  let side = 2 * radius + 1;
  let k = u32(side * side) / 2u;
  var visible = 0u;
  for (var dy = -radius; dy <= radius; dy++) {
    for (var dx = -radius; dx <= radius; dx++) {
      visible += select(0u, 1u, alpha_of(at_src(x + dx, y + dy, width, height)) > 0u);
    }
  }
  if (visible == 0u) {
    dst[i] = 0u;
    return;
  }
  let kc = visible / 2u;
  var m = vec4u(0u);
  for (var bit = 7; bit >= 0; bit--) {
    let cand = m | vec4u(1u << u32(bit));
    var below = vec4u(0u);
    for (var dy = -radius; dy <= radius; dy++) {
      for (var dx = -radius; dx <= radius; dx++) {
        let p = bytes4(at_src(x + dx, y + dy, width, height));
        let shown = select(0u, 1u, p.w > 0u);
        below += vec4u(select(0u, 1u, p.x < cand.x) & shown, select(0u, 1u, p.y < cand.y) & shown,
                       select(0u, 1u, p.z < cand.z) & shown, select(0u, 1u, p.w < cand.w));
      }
    }
    if (below.x <= kc) { m.x = cand.x; }
    if (below.y <= kc) { m.y = cand.y; }
    if (below.z <= kc) { m.z = cand.z; }
    if (below.w <= k) { m.w = cand.w; }
  }
  dst[i] = pack_bytes(m);`,
  },

  crosshatch: {
    args: 'src:in dst:out width:i32 height:i32 spacing:f32 line_width:f32 colour:i32',
    helpers: `
fn hatch(v: f32, spacing: f32, line_width: f32) -> f32 {
  let d = abs(v - spacing * round(v / spacing));
  return 1.0 - smoothstep(line_width * 0.5 - 0.5, line_width * 0.5 + 0.5, d);
}`,
    body: `
  let c = to_rgb(src[i]);
  let l = luma(c);
  let a = f32(x + y) * 0.70710678;
  let b = f32(x - y) * 0.70710678;
  var ink = 0.0;
  if (l < 0.85) { ink = max(ink, hatch(a, spacing, line_width)); }
  if (l < 0.65) { ink = max(ink, hatch(b, spacing, line_width)); }
  if (l < 0.45) { ink = max(ink, hatch(a + spacing * 0.5, spacing, line_width)); }
  if (l < 0.25) { ink = max(ink, hatch(b + spacing * 0.5, spacing, line_width)); }
  let paper = vec3f(0.98, 0.96, 0.91);
  var pen = vec3f(0.12, 0.12, 0.16);
  if (colour != 0) { pen = c * 0.7; }
  dst[i] = from_rgb(mix(paper, pen, ink), alpha_of(src[i]));`,
  },

  structure_tensor: {
    args: 'src:in tensor:f4out width:i32 height:i32',
    body: `
  let fx = (rgb_at_src(x + 1, y - 1, width, height) + 2.0 * rgb_at_src(x + 1, y, width, height) +
            rgb_at_src(x + 1, y + 1, width, height) - rgb_at_src(x - 1, y - 1, width, height) -
            2.0 * rgb_at_src(x - 1, y, width, height) - rgb_at_src(x - 1, y + 1, width, height)) * 0.25;
  let fy = (rgb_at_src(x - 1, y + 1, width, height) + 2.0 * rgb_at_src(x, y + 1, width, height) +
            rgb_at_src(x + 1, y + 1, width, height) - rgb_at_src(x - 1, y - 1, width, height) -
            2.0 * rgb_at_src(x, y - 1, width, height) - rgb_at_src(x + 1, y - 1, width, height)) * 0.25;
  tensor[i] = vec4f(dot(fx, fx), dot(fx, fy), dot(fy, fy), 0.0);`,
  },

  tensor_orientation: {
    args: 'tensor:f4s orient:f4out width:i32 height:i32',
    body: `
  let g = tensor[i];
  let root = sqrt((g.x - g.z) * (g.x - g.z) + 4.0 * g.y * g.y);
  let lambda1 = 0.5 * (g.x + g.z + root);
  let lambda2 = 0.5 * (g.x + g.z - root);
  let v = vec2f(lambda1 - g.x, -g.y);
  var t = vec2f(0.0, 1.0);
  if (length(v) > 0.0) { t = normalize(v); }
  let phi = -atan2(t.y, t.x);
  var a = 0.0;
  if (lambda1 + lambda2 > 0.0) { a = (lambda1 - lambda2) / (lambda1 + lambda2); }
  orient[i] = vec4f(t, phi, a);`,
  },

  anisotropic_kuwahara: {
    args: 'src:in orient:f4s dst:out width:i32 height:i32 radius:f32 q:f32 alpha:f32 row0:i32',
    guard: 'band',
    body: `
  var m: array<vec4f, 8>;
  var s: array<vec3f, 8>;
  var w: array<f32, 8>;
  let o = orient[i];
  let a = radius * clamp((alpha + o.w) / alpha, 0.1, 2.0);
  let b = radius * clamp(alpha / (alpha + o.w), 0.1, 2.0);
  let cos_phi = cos(o.z);
  let sin_phi = sin(o.z);
  let sr0 = vec2f(cos_phi, sin_phi) * (0.5 / a);
  let sr1 = vec2f(-sin_phi, cos_phi) * (0.5 / b);
  let max_x = i32(sqrt(a * a * cos_phi * cos_phi + b * b * sin_phi * sin_phi));
  let max_y = i32(sqrt(a * a * sin_phi * sin_phi + b * b * cos_phi * cos_phi));
  let zeta = 2.0 / radius;
  let zero_cross = 3.0 * PI / 8.0;
  let sin_zc = sin(zero_cross);
  let eta = (zeta + cos(zero_cross)) / (sin_zc * sin_zc);
  var stride = 1;
  if (radius > 4.0) { stride = 2; }
  for (var j = -max_y; j <= max_y; j += stride) {
    for (var k = -max_x; k <= max_x; k += stride) {
      var v = vec2f(dot(sr0, vec2f(f32(k), f32(j))), dot(sr1, vec2f(f32(k), f32(j))));
      if (dot(v, v) > 0.25) { continue; }
      let p = at_src(x + k, y + j, width, height);
      if (alpha_of(p) == 0u) { continue; }
      let c = to_rgb(p);
      var sum = 0.0;
      var vxx = zeta - eta * v.x * v.x;
      var vyy = zeta - eta * v.y * v.y;
      var z: f32;
      z = max(0.0, v.y + vxx); w[0] = z * z; sum += w[0];
      z = max(0.0, -v.x + vyy); w[2] = z * z; sum += w[2];
      z = max(0.0, -v.y + vxx); w[4] = z * z; sum += w[4];
      z = max(0.0, v.x + vyy); w[6] = z * z; sum += w[6];
      v = 0.70710678 * vec2f(v.x - v.y, v.x + v.y);
      vxx = zeta - eta * v.x * v.x;
      vyy = zeta - eta * v.y * v.y;
      z = max(0.0, v.y + vxx); w[1] = z * z; sum += w[1];
      z = max(0.0, -v.x + vyy); w[3] = z * z; sum += w[3];
      z = max(0.0, -v.y + vxx); w[5] = z * z; sum += w[5];
      z = max(0.0, v.x + vyy); w[7] = z * z; sum += w[7];
      let g = exp(-3.125 * dot(v, v)) / sum * (f32(alpha_of(p)) * (1.0 / 255.0));
      for (var n = 0; n < 8; n++) {
        let wk = w[n] * g;
        m[n] += vec4f(c * wk, wk);
        s[n] += c * c * wk;
      }
    }
  }
  var out = vec4f(0.0);
  for (var n = 0; n < 8; n++) {
    if (m[n].w <= 0.0) { continue; }
    let mean = m[n].xyz / m[n].w;
    let variance = abs(s[n] / m[n].w - mean * mean);
    let sigma2 = variance.x + variance.y + variance.z;
    let wn = 1.0 / (1.0 + pow(255.0 * sigma2, 0.5 * q));
    out += vec4f(mean * wn, wn);
  }
  var rgb = vec3f(0.0);
  if (out.w > 0.0) { rgb = out.xyz / out.w; }
  dst[i] = from_rgb(rgb, alpha_of(src[i]));`,
  },
};
