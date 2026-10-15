'use strict';

// native/kernels/adjust.cl: histograms (workgroup atomics), reductions and
// prefix sums. WGSL can't pass workgroup arrays to functions, so the scans
// and reductions are written out in each kernel; and every kernel here runs
// with 256 work-items per group, as the plans ask, so the "stride by the
// group size" loops of the OpenCL versions become one bin per work-item.

// Inclusive Hillis-Steele scan of a[0..255] into a, using b as scratch; 8
// steps, an even number, so the result ends up back in a. `lid` is the bin.
const scan = (a, b) => `
  for (var offset = 1; offset < 256; offset <<= 1u) {
    let step_odd = (countTrailingZeros(u32(offset)) & 1u) == 1u;
    if (step_odd) {
      var v = ${b}[lid.x];
      if (i32(lid.x) >= offset) { v += ${b}[i32(lid.x) - offset]; }
      ${a}[lid.x] = v;
    } else {
      var v = ${a}[lid.x];
      if (i32(lid.x) >= offset) { v += ${a}[i32(lid.x) - offset]; }
      ${b}[lid.x] = v;
    }
    workgroupBarrier();
  }`;

const reduce = (a) => `
  for (var s = 128u; s > 0u; s >>= 1u) {
    if (lid.x < s) { ${a}[lid.x] += ${a}[lid.x + s]; }
    workgroupBarrier();
  }`;

exports.ADJUST = {
  histogram: {
    args: 'src:in hist:i32atomic count:i32',
    guard: 'none',
    workgroup: [256],
    barriers: true,
    helpers: 'var<workgroup> local_hist: array<atomic<i32>, 1024>;',
    body: `
  for (var b = lid.x; b < 1024u; b += 256u) { atomicStore(&local_hist[b], 0); }
  workgroupBarrier();
  for (var p = i32(gid.x); p < count; p += i32(args.global_.x)) {
    let px4 = bytes4(src[p]);
    if (px4.w == 0u) { continue; }
    atomicAdd(&local_hist[px4.x], 1);
    atomicAdd(&local_hist[256u + px4.y], 1);
    atomicAdd(&local_hist[512u + px4.z], 1);
    atomicAdd(&local_hist[768 + luma_bin(src[p])], 1);
  }
  workgroupBarrier();
  for (var b = lid.x; b < 1024u; b += 256u) {
    let v = atomicLoad(&local_hist[b]);
    if (v != 0) { atomicAdd(&hist[b], v); }
  }`
  },

  equalize_lut: {
    args: 'hist:i32s lut:f32out',
    guard: 'none',
    workgroup: [256],
    barriers: true,
    helpers: `
var<workgroup> cdf: array<i32, 256>;
var<workgroup> scratch: array<i32, 256>;
var<workgroup> cdf_min: i32;`,
    body: `
  cdf[lid.x] = hist[768u + lid.x];
  workgroupBarrier();
  ${scan('cdf', 'scratch')}
  if (lid.x == 0u) {
    var m = 0;
    for (var b = 0; b < 256; b++) {
      if (cdf[b] > 0) {
        m = cdf[b];
        break;
      }
    }
    cdf_min = m;
  }
  workgroupBarrier();
  let total = cdf[255];
  let lo = cdf_min;
  lut[lid.x] = clamp(f32(cdf[lid.x] - lo) / f32(max(total - lo, 1)), 0.0, 1.0);
  if (lid.x == 0u) { lut[256] = select(0.0, 1.0, total > lo); }`
  },

  apply_luma_lut: {
    args: 'src:in lut:f32s dst:out width:i32 height:i32 amount:f32',
    body: `
  let c = to_rgb(src[i]);
  let o = with_luma(c, lut[luma_bin(src[i])]);
  dst[i] = from_rgb(mix(c, o, amount * lut[256]), alpha_of(src[i]));`
  },

  auto_levels_params: {
    args: 'hist:i32s params:f32out clip:f32 linked:i32',
    guard: 'none',
    workgroup: [64],
    body: `
  let c = i32(gid.x);
  if (c >= 3) { return; }
  var h0 = c * 256;
  if (linked != 0) { h0 = 768; }
  var count = 0;
  for (var b = 0; b < 256; b++) { count += hist[h0 + b]; }
  let limit = i32(clip * f32(count));
  var low = 0;
  var high = 255;
  var sum = 0;
  for (var b = 0; b < 256; b++) {
    sum += hist[h0 + b];
    if (sum > limit) {
      low = b;
      break;
    }
  }
  sum = 0;
  for (var b = 255; b >= 0; b--) {
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
  params[c * 2] = f32(low) / 255.0;
  params[c * 2 + 1] = f32(high) / 255.0;`
  },

  apply_levels: {
    args: 'src:in params:f32s dst:out width:i32 height:i32',
    body: `
  let c = to_rgb(src[i]);
  let low = vec3f(params[0], params[2], params[4]);
  let high = vec3f(params[1], params[3], params[5]);
  dst[i] = from_rgb((c - low) / (high - low), alpha_of(src[i]));`
  },

  clahe_hist: {
    args: 'src:in hists:i32out width:i32 height:i32 tiles_x:i32 tiles_y:i32',
    guard: 'none',
    workgroup: [256],
    barriers: true,
    helpers: 'var<workgroup> h: array<atomic<i32>, 256>;',
    body: `
  let tile = i32(wid.x);
  let tx = tile % tiles_x;
  let ty = tile / tiles_x;
  let x0 = tx * width / tiles_x;
  let x1 = (tx + 1) * width / tiles_x;
  let y0 = ty * height / tiles_y;
  let y1 = (ty + 1) * height / tiles_y;
  let tw = x1 - x0;
  let count = tw * (y1 - y0);
  atomicStore(&h[lid.x], 0);
  workgroupBarrier();
  for (var p = i32(lid.x); p < count; p += 256) {
    let v = src[(y0 + p / tw) * width + x0 + p % tw];
    if (alpha_of(v) != 0u) { atomicAdd(&h[luma_bin(v)], 1); }
  }
  workgroupBarrier();
  hists[tile * 256 + i32(lid.x)] = atomicLoad(&h[lid.x]);`
  },

  clahe_lut: {
    args: 'hists:i32s luts:f32out clip_limit:f32',
    guard: 'none',
    workgroup: [256],
    barriers: true,
    helpers: `
var<workgroup> sums: array<i32, 256>;
var<workgroup> curve: array<f32, 256>;
var<workgroup> scratch: array<f32, 256>;`,
    body: `
  let tile = i32(wid.x);
  let hv = hists[tile * 256 + i32(lid.x)];
  sums[lid.x] = hv;
  workgroupBarrier();
  ${reduce('sums')}
  let total = sums[0];
  workgroupBarrier();
  let limit = max(1, i32(clip_limit * f32(total) / 256.0));
  sums[lid.x] = max(hv - limit, 0);
  workgroupBarrier();
  ${reduce('sums')}
  let excess = sums[0];
  curve[lid.x] = f32(min(hv, limit)) + f32(excess) / 256.0;
  workgroupBarrier();
  ${scan('curve', 'scratch')}
  var v = f32(lid.x) / 255.0;
  if (total != 0) { v = curve[lid.x] / f32(total); }
  luts[tile * 256 + i32(lid.x)] = v;`
  },

  clahe_apply: {
    args: 'src:in luts:f32s dst:out width:i32 height:i32 tiles_x:i32 tiles_y:i32 amount:f32',
    body: `
  let bin = luma_bin(src[i]);
  let fx = (f32(x) + 0.5) * f32(tiles_x) / f32(width) - 0.5;
  let fy = (f32(y) + 0.5) * f32(tiles_y) / f32(height) - 0.5;
  let tx0 = clamp(i32(floor(fx)), 0, tiles_x - 1);
  let ty0 = clamp(i32(floor(fy)), 0, tiles_y - 1);
  let tx1 = min(tx0 + 1, tiles_x - 1);
  let ty1 = min(ty0 + 1, tiles_y - 1);
  let ax = clamp(fx - f32(tx0), 0.0, 1.0);
  let ay = clamp(fy - f32(ty0), 0.0, 1.0);
  let v00 = luts[(ty0 * tiles_x + tx0) * 256 + bin];
  let v10 = luts[(ty0 * tiles_x + tx1) * 256 + bin];
  let v01 = luts[(ty1 * tiles_x + tx0) * 256 + bin];
  let v11 = luts[(ty1 * tiles_x + tx1) * 256 + bin];
  let v = mix(mix(v00, v10, ax), mix(v01, v11, ax), ay);
  let c = to_rgb(src[i]);
  dst[i] = from_rgb(mix(c, with_luma(c, v), amount), alpha_of(src[i]));`
  }
};
