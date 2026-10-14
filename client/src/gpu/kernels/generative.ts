// native/kernels/generative.cl.
import { KernelSpec } from '../kernel';

export const GENERATIVE: Record<string, KernelSpec> = {
  jfa_clear: {
    args: 'cells:i32out width:i32 height:i32',
    body: `
  cells[i] = -1;`,
  },

  jfa_plant: {
    args: 'seeds:i2s cells:i32out width:i32 height:i32 count:i32',
    guard: 'none',
    body: `
  let s = i32(gid.x);
  if (s >= count) { return; }
  let p = seeds[s];
  cells[p.y * width + p.x] = s;`,
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
  cells_out[i] = best;`,
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
  atomicAdd(&sums[cell + 8u], 1u);`,
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
  dst[i] = from_rgb(c, sat_u8(alpha_sum / n));`,
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
  state[y * gw + x] = vec4f(1.0 - 0.5 * v, v, feed, kill + (l - 0.5) * kill_range);`,
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
  cells_out[y * gw + x] = vec4f(clamp(nu, 0.0, 1.0), clamp(nv, 0.0, 1.0), f, k);`,
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
  dst[i] = from_rgb(o, sat_u8(photo.w * 255.0));`,
  },
};
