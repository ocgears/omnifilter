'use strict';

// native/kernels/generative.cl.

exports.GENERATIVE = {
  jfa_clear: {
    args: 'cells:i32out width:i32 height:i32',
    body: `
  cells[i] = -1;`
  },

  jfa_plant: {
    args: 'seeds:i2s cells:i32out width:i32 height:i32 count:i32',
    guard: 'none',
    body: `
  let s = i32(gid.x);
  if (s >= count) { return; }
  let p = seeds[s];
  cells[p.y * width + p.x] = s;`
  },

  jfa_step: {
    args: 'cells_in:i32s cells_out:i32out seeds:i2s width:i32 height:i32 jump:i32',
    helpers: `
fn seed_dist2(seed: vec2i, x: i32, y: i32) -> f32 {
  let dx = f32(seed.x - x);
  let dy = f32(seed.y - y);
  return dx * dx + dy * dy;
}`,
    body: `
  var best = cells_in[i];
  var best_d = MAXFLOAT;
  if (best >= 0) { best_d = seed_dist2(seeds[best], x, y); }
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let nx = x + dx * jump;
      let ny = y + dy * jump;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) { continue; }
      let s = cells_in[ny * width + nx];
      if (s < 0) { continue; }
      let d = seed_dist2(seeds[s], x, y);
      if (d < best_d) {
        best_d = d;
        best = s;
      }
    }
  }
  cells_out[i] = best;`
  },

  // Each cell's sums are 9 uints: colour times alpha for red, green and blue,
  // then alpha, as 64-bit (low, high) pairs, then the pixel count.
  cell_accumulate: {
    args: 'src:in cells:i32s sums:u32atomic width:i32 height:i32',
    helpers: `
fn atomic_add_u64(k: u32, value: u32) {
  let old = atomicAdd(&sums[k], value);
  if (old + value < old) { atomicAdd(&sums[k + 1u], 1u); }
}`,
    body: `
  let s = cells[i];
  if (s < 0) { return; }
  let p = bytes4(src[i]);
  let cell = u32(s) * 9u;
  if (p.w != 0u) {
    atomic_add_u64(cell + 0u, p.x * p.w);
    atomic_add_u64(cell + 2u, p.y * p.w);
    atomic_add_u64(cell + 4u, p.z * p.w);
    atomic_add_u64(cell + 6u, p.w);
  }
  atomicAdd(&sums[cell + 8u], 1u);`
  },

  stained_glass: {
    args: 'cells:i32s sums:u32s dst:out width:i32 height:i32 line_width:f32',
    helpers: `
fn read_u64(k: u32) -> f32 {
  return f32(sums[k + 1u]) * 4294967296.0 + f32(sums[k]);
}`,
    body: `
  let s = cells[i];
  let cell = u32(s) * 9u;
  let alpha_sum = read_u64(cell + 6u);
  let n = f32(max(sums[cell + 8u], 1u));
  var c = vec3f(0.0);
  if (alpha_sum > 0.0) {
    c = vec3f(read_u64(cell), read_u64(cell + 2u), read_u64(cell + 4u)) / (255.0 * alpha_sum);
  }
  var edge = 0.0;
  for (var a = 0; a < 8; a++) {
    let angle = f32(a) * PI / 4.0;
    for (var r = 1; r <= 2; r++) {
      let dist = line_width * f32(r) * 0.5;
      let nx = clamp(i32(f32(x) + cos(angle) * dist + 0.5), 0, width - 1);
      let ny = clamp(i32(f32(y) + sin(angle) * dist + 0.5), 0, height - 1);
      if (cells[ny * width + nx] != s) { edge = max(edge, select(0.35, 1.0, r == 1)); }
    }
  }
  let l = luma(c);
  c = clamp(l + (c - l) * 1.25, vec3f(0.0), vec3f(1.0));
  c = mix(c, vec3f(0.06, 0.06, 0.07), edge);
  dst[i] = from_rgb(c, sat_u8(alpha_sum / n));`
  },

  rd_init: {
    args: 'src:img state:f4out gw:i32 gh:i32 width:i32 height:i32 feed:f32 kill:f32 kill_range:f32 seed:i32',
    guard: 'none',
    workgroup: [8, 8],
    body: `
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= gw || y >= gh) { return; }
  let p = vec2f((f32(x) + 0.5) * f32(width) / f32(gw), (f32(y) + 0.5) * f32(height) / f32(gh));
  let l = luma(sample_rgba_src(p, width, height).xyz);
  let h = hash3(u32(x / 3), u32(y / 3), u32(seed));
  let v = select(0.0, 1.0, f32(h & 0xffffu) < 65535.0 * 0.08);
  state[y * gw + x] = vec4f(1.0 - 0.5 * v, v, feed, kill + (l - 0.5) * kill_range);`
  },

  rd_step: {
    args: 'cells_in:f4s cells_out:f4out gw:i32 gh:i32 du:f32 dv:f32 dt:f32',
    guard: 'none',
    workgroup: [8, 8],
    body: `
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= gw || y >= gh) { return; }
  let xl = max(x - 1, 0);
  let xr = min(x + 1, gw - 1);
  let yu = max(y - 1, 0);
  let yd = min(y + 1, gh - 1);
  let c = cells_in[y * gw + x];
  let lap =
      0.2 * (cells_in[y * gw + xl].xy + cells_in[y * gw + xr].xy + cells_in[yu * gw + x].xy + cells_in[yd * gw + x].xy) +
      0.05 * (cells_in[yu * gw + xl].xy + cells_in[yu * gw + xr].xy + cells_in[yd * gw + xl].xy + cells_in[yd * gw + xr].xy) -
      c.xy;
  let u = c.x;
  let v = c.y;
  let f = c.z;
  let k = c.w;
  let uvv = u * v * v;
  let nu = u + (du * lap.x - uvv + f * (1.0 - u)) * dt;
  let nv = v + (dv * lap.y + uvv - (k + f) * v) * dt;
  cells_out[y * gw + x] = vec4f(clamp(nu, 0.0, 1.0), clamp(nv, 0.0, 1.0), f, k);`
  },

  rd_render: {
    args: 'state:imgf4 src:img dst:out width:i32 height:i32 gw:i32 gh:i32 mode:i32',
    body: `
  let gp = vec2f((f32(x) + 0.5) * f32(gw) / f32(width), (f32(y) + 0.5) * f32(gh) / f32(height));
  let v = linear_state(gp, gw, gh).y;
  let t = smoothstep(0.15, 0.35, v);
  let photo = px(src[i]);
  var o: vec3f;
  if (mode == 0) {
    o = mix(vec3f(0.96, 0.94, 0.88), vec3f(0.1, 0.12, 0.2), t);
  } else {
    let c = photo.xyz;
    let l = luma(c);
    let vivid = clamp(l + (c - l) * 1.4, vec3f(0.0), vec3f(1.0));
    o = mix(c * 0.12, vivid, t);
  }
  dst[i] = from_rgb(o, sat_u8(photo.w * 255.0));`
  },

  fractal: {
    args: 'src:in dst:out width:i32 height:i32 center_x:f32 center_y:f32 scale:f32 seed_re:f32 seed_im:f32 fractal_type:i32 mode:i32 palette:i32 max_iter:i32 blend_amount:f32 row0:i32',
    guard: 'band',
    helpers: `
fn fractal_palette(t: f32, palette: i32) -> vec3f {
  let s = clamp(t, 0.0, 1.0);
  let inv = 1.0 - s;
  if (palette == 1) {
    return vec3f(s * s * 0.75, s * (1.5 - 0.5 * s) * 0.95, 0.25 + 0.75 * sqrt(s));
  }
  if (palette == 2) {
    return vec3f(min(1.0, s * 1.65), s * s * 0.95, s * s * s * s * 0.65);
  }
  if (palette == 3) {
    return vec3f(s * s * 0.35, 0.15 + 0.85 * sqrt(s), s * 0.65);
  }
  return vec3f(
    9.0 * inv * s * s * s,
    15.0 * inv * inv * s * s,
    8.5 * inv * inv * inv * s
  );
}`,
    body: `
  let raw_px = src[i];
  let photo = to_rgba(raw_px);
  let photo_rgb = select(vec3f(0.0), photo.xyz, photo.w > 0.0);

  let short_side = f32(max(min(width, height), 1));
  let nx = (f32(x) + 0.5 - 0.5 * f32(width)) / short_side;
  let ny = (f32(y) + 0.5 - 0.5 * f32(height)) / short_side;
  let coord_re = nx * scale + center_x;
  let coord_im = ny * scale + center_y;

  var c_re = seed_re;
  var c_im = seed_im;
  var eff_type = fractal_type;

  if (mode == 1) {
    var sum_rgb = vec3f(0.0);
    var sum_a = 0.0;
    for (var s = 0; s < 16; s++) {
      let gx = s & 3;
      let gy = s >> 2;
      let sx = ((gx * 2 + 1) * width) / 8;
      let sy = ((gy * 2 + 1) * height) / 8;
      let sp = premul_pixel(at_src(sx, sy, width, height));
      sum_rgb += sp.xyz;
      sum_a += sp.w;
    }
    let mean_rgb = select(vec3f(0.5), sum_rgb / sum_a, sum_a > 0.0);
    let theta = (mean_rgb.x * 1.7 + mean_rgb.y * 2.3 + mean_rgb.z * 3.1) * (2.0 * PI);
    let card_re = 0.5 * cos(theta) - 0.25 * cos(2.0 * theta);
    let card_im = 0.5 * sin(theta) - 0.25 * sin(2.0 * theta);
    c_re = card_re + (seed_re + 0.4) * 0.08;
    c_im = card_im + (seed_im - 0.6) * 0.08;
    eff_type = 1;
  }

  var z_re = select(0.0, coord_re, eff_type == 1);
  var z_im = select(0.0, coord_im, eff_type == 1);
  let cr = select(coord_re, c_re, eff_type == 1);
  let ci = select(coord_im, c_im, eff_type == 1);

  if (mode == 1) {
    let lum = luma(photo_rgb);
    z_re += (lum - 0.5) * scale * 0.08;
    z_im += (photo_rgb.x - photo_rgb.z) * scale * 0.06;
  }

  var iter = 0;
  var mag_sq = 0.0;
  var min_trap = 10.0;

  for (var step_i = 0; step_i < max_iter; step_i++) {
    let zr2 = z_re * z_re;
    let zi2 = z_im * z_im;
    mag_sq = zr2 + zi2;
    if (mag_sq > 4.0) { break; }
    var next_im = 2.0 * z_re * z_im + ci;
    if (eff_type == 2) {
      next_im = 2.0 * abs(z_re * z_im) + ci;
    } else if (eff_type == 3) {
      next_im = -2.0 * z_re * z_im + ci;
    }
    z_re = zr2 - zi2 + cr;
    z_im = next_im;
    min_trap = min(min_trap, abs(z_re) + abs(z_im));
    iter++;
  }

  let escaped = iter < max_iter;
  var smooth_val = f32(iter);
  if (escaped && mag_sq > 1.0001) {
    let log_zn = 0.5 * log2(mag_sq);
    let nu = clamp(log2(max(log_zn, 0.0001)), -2.0, 4.0);
    smooth_val = max(0.0, f32(iter) + 1.0 - nu);
  }
  let t = clamp(smooth_val / f32(max(max_iter, 1)), 0.0, 1.0);
  let frac_col = select(vec3f(0.03, 0.04, 0.07), clamp(fractal_palette(t, palette), vec3f(0.0), vec3f(1.0)), escaped);

  var out_rgb: vec3f;
  if (mode == 0) {
    let target = select(photo_rgb * 0.35, frac_col, escaped);
    let mix_amt = select(blend_amount * 0.5, blend_amount, escaped);
    out_rgb = mix(photo_rgb, target, mix_amt);
  } else if (mode == 1) {
    let lum = luma(photo_rgb);
    let vivid = clamp(lum + (photo_rgb - lum) * 1.35, vec3f(0.0), vec3f(1.0));
    let trap_t = clamp(1.0 - min_trap * 0.45, 0.0, 1.0);
    let seeded_col = select(mix(vivid * 0.25, frac_col, 0.4), mix(frac_col, vivid, 0.38 * trap_t), escaped);
    out_rgb = mix(photo_rgb, seeded_col, blend_amount);
  } else {
    out_rgb = mix(photo_rgb, frac_col, blend_amount);
  }

  dst[i] = from_rgb(clamp(out_rgb, vec3f(0.0), vec3f(1.0)), alpha_of(raw_px));`
  }
};
