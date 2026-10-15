// Automatic adjustments driven by whole-image statistics. These show three
// classic GPU building blocks:
// - histograms with atomic counters (first per work-group in fast local
//   memory, then merged into global memory, to avoid millions of contended
//   global atomics),
// - parallel reduction (summing an array in log2(n) steps),
// - parallel prefix sum / scan (the cumulative histogram, in log2(n) steps).
//
// Work-group sizes: plans ask for 256 work-items per group, but some devices
// allow fewer (Apple's CPU device, for one), and the addon then launches
// smaller groups. So every kernel here loops over its bins with a stride of
// the actual group size instead of assuming one work-item per bin.

// Histograms of red, green, blue and luma: hist[0..255] is red, [256..511]
// green, [512..767] blue and [768..1023] luma. Run in 1D with any number of
// work-groups; each work-item strides through the image so they cover all
// pixels between them. Fully transparent pixels aren't counted: their colour
// is hidden, so it shouldn't steer the adjustment.
__kernel void histogram(__global const uchar4 *src,
                        __global int *hist,
                        const int count)
{
  __local int local_hist[1024];
  const int lid = get_local_id(0);
  const int lsize = get_local_size(0);
  for (int b = lid; b < 1024; b += lsize) local_hist[b] = 0;
  barrier(CLK_LOCAL_MEM_FENCE);

  for (int p = get_global_id(0); p < count; p += get_global_size(0)) {
    const uchar4 px = src[p];
    if (!px.w) continue;
    atomic_inc(&local_hist[px.x]);
    atomic_inc(&local_hist[256 + px.y]);
    atomic_inc(&local_hist[512 + px.z]);
    atomic_inc(&local_hist[768 + luma_bin(px)]);
  }
  barrier(CLK_LOCAL_MEM_FENCE);

  for (int b = lid; b < 1024; b += lsize) {
    if (local_hist[b]) atomic_add(&hist[b], local_hist[b]);
  }
}

// Inclusive prefix sum of 256 values in local memory (Hillis-Steele), in
// log2(256) = 8 steps. Each step reads one array and writes the other, so it
// works with any number of work-items; after the 8 steps (an even number) the
// result is back in `data`. Must be called by every work-item of the group.
void scan256_int(__local int *data, __local int *scratch) {
  const int lid = get_local_id(0);
  const int lsize = get_local_size(0);
  __local int *from = data;
  __local int *to = scratch;
  for (int offset = 1; offset < 256; offset <<= 1) {
    for (int i = lid; i < 256; i += lsize) to[i] = from[i] + (i >= offset ? from[i - offset] : 0);
    barrier(CLK_LOCAL_MEM_FENCE);
    __local int *t = from;
    from = to;
    to = t;
  }
}

void scan256_float(__local float *data, __local float *scratch) {
  const int lid = get_local_id(0);
  const int lsize = get_local_size(0);
  __local float *from = data;
  __local float *to = scratch;
  for (int offset = 1; offset < 256; offset <<= 1) {
    for (int i = lid; i < 256; i += lsize) to[i] = from[i] + (i >= offset ? from[i - offset] : 0.0f);
    barrier(CLK_LOCAL_MEM_FENCE);
    __local float *t = from;
    from = to;
    to = t;
  }
}

// Sums 256 values in local memory into data[0] by tree reduction, in 8 steps.
// Works with any number of work-items; must be called by all of them.
void reduce256_int(__local int *data) {
  const int lid = get_local_id(0);
  const int lsize = get_local_size(0);
  for (int s = 128; s > 0; s >>= 1) {
    for (int i = lid; i < s; i += lsize) data[i] += data[i + s];
    barrier(CLK_LOCAL_MEM_FENCE);
  }
}

// Histogram equalization: turns the cumulative luma histogram into a curve
// that spreads brightness levels evenly. Runs as one work-group. lut has 257
// entries: the curve, then how much of it to apply, which is 0 when every
// counted pixel has the same luma (or there are none), so a flat image is
// left alone rather than pushed to black.
__kernel void equalize_lut(__global const int *hist,
                           __global float *lut)
{
  __local int cdf[256];
  __local int scratch[256];
  __local int cdf_min;
  const int lid = get_local_id(0);
  const int lsize = get_local_size(0);
  for (int i = lid; i < 256; i += lsize) cdf[i] = hist[768 + i];
  barrier(CLK_LOCAL_MEM_FENCE);
  scan256_int(cdf, scratch);
  if (lid == 0) {
    int m = 0;
    for (int b = 0; b < 256; b++) {
      if (cdf[b] > 0) {
        m = cdf[b];
        break;
      }
    }
    cdf_min = m;
  }
  barrier(CLK_LOCAL_MEM_FENCE);
  const int total = cdf[255];
  for (int i = lid; i < 256; i += lsize) {
    lut[i] = clamp((float)(cdf[i] - cdf_min) / (float)max(total - cdf_min, 1), 0.0f, 1.0f);
  }
  if (lid == 0) lut[256] = total > cdf_min ? 1.0f : 0.0f;
}

// Remaps each pixel's luma through a 256-entry curve, keeping its colour;
// lut[256] scales amount.
__kernel void apply_luma_lut(__global const uchar4 *src,
                             __global const float *lut,
                             __global uchar4 *dst,
                             const int width,
                             const int height,
                             const float amount)
{
  GUARD;
  const float3 c = to_rgb(src[i]);
  const float3 o = with_luma(c, lut[luma_bin(src[i])]);
  dst[i] = from_rgb(mix(c, o, amount * lut[256]), src[i].w);
}

// Auto levels: finds each channel's darkest and brightest levels, ignoring
// the `clip` fraction of outlying pixels at each end. With linked set, all
// channels use the luma histogram (auto contrast, no colour change);
// otherwise each channel is stretched separately (auto colour, which also
// removes colour casts). One work-item per channel. clip is a fraction of
// the pixels counted (the visible ones).
__kernel void auto_levels_params(__global const int *hist,
                                 __global float *params,
                                 const float clip,
                                 const int linked)
{
  const int c = get_global_id(0);
  if (c >= 3) return;
  __global const int *h = hist + (linked ? 768 : c * 256);
  int count = 0;
  for (int b = 0; b < 256; b++) count += h[b];
  const int limit = (int)(clip * count);
  int low = 0, high = 255, sum = 0;
  for (int b = 0; b < 256; b++) {
    sum += h[b];
    if (sum > limit) {
      low = b;
      break;
    }
  }
  sum = 0;
  for (int b = 255; b >= 0; b--) {
    sum += h[b];
    if (sum > limit) {
      high = b;
      break;
    }
  }
  if (high <= low) {
    low = 0;
    high = 255;
  }
  params[c * 2] = low / 255.0f;
  params[c * 2 + 1] = high / 255.0f;
}

__kernel void apply_levels(__global const uchar4 *src,
                           __global const float *params,
                           __global uchar4 *dst,
                           const int width,
                           const int height)
{
  GUARD;
  const float3 c = to_rgb(src[i]);
  const float3 low = (float3)(params[0], params[2], params[4]);
  const float3 high = (float3)(params[1], params[3], params[5]);
  dst[i] = from_rgb((c - low) / (high - low), src[i].w);
}

// ---- CLAHE: contrast-limited adaptive histogram equalization ----------------
// Equalizes each tile of a grid separately, limiting how steep each tile's
// curve can get (so noise isn't amplified), then blends between the four
// nearest tiles' curves so no tile edges show.

// One work-group per tile builds that tile's luma histogram, leaving out
// fully transparent pixels.
__kernel void clahe_hist(__global const uchar4 *src,
                         __global int *hists,
                         const int width,
                         const int height,
                         const int tiles_x,
                         const int tiles_y)
{
  __local int h[256];
  const int tile = get_group_id(0);
  const int lid = get_local_id(0);
  const int lsize = get_local_size(0);
  const int tx = tile % tiles_x;
  const int ty = tile / tiles_x;
  const int x0 = tx * width / tiles_x;
  const int x1 = (tx + 1) * width / tiles_x;
  const int y0 = ty * height / tiles_y;
  const int y1 = (ty + 1) * height / tiles_y;
  const int tw = x1 - x0;
  const int count = tw * (y1 - y0);

  for (int b = lid; b < 256; b += lsize) h[b] = 0;
  barrier(CLK_LOCAL_MEM_FENCE);
  for (int p = lid; p < count; p += lsize) {
    const uchar4 px = src[(y0 + p / tw) * width + x0 + p % tw];
    if (px.w) atomic_inc(&h[luma_bin(px)]);
  }
  barrier(CLK_LOCAL_MEM_FENCE);
  for (int b = lid; b < 256; b += lsize) hists[tile * 256 + b] = h[b];
}

// One work-group per tile: clip the histogram at clip_limit times the
// average bin height, share the clipped excess out evenly, then scan it into
// a curve. A tile with no visible pixels gets a straight line, so it doesn't
// darken the visible tiles it's blended with.
__kernel void clahe_lut(__global const int *hists,
                        __global float *luts,
                        const float clip_limit)
{
  __local int sums[256];
  __local float curve[256];
  __local float scratch[256];
  const int tile = get_group_id(0);
  const int lid = get_local_id(0);
  const int lsize = get_local_size(0);
  __global const int *h = hists + tile * 256;

  // Reduction: total pixels in the tile.
  for (int i = lid; i < 256; i += lsize) sums[i] = h[i];
  barrier(CLK_LOCAL_MEM_FENCE);
  reduce256_int(sums);
  const int total = sums[0];
  barrier(CLK_LOCAL_MEM_FENCE);

  // Reduction: total excess above the clip limit.
  const int limit = max(1, (int)(clip_limit * total / 256.0f));
  for (int i = lid; i < 256; i += lsize) sums[i] = max(h[i] - limit, 0);
  barrier(CLK_LOCAL_MEM_FENCE);
  reduce256_int(sums);
  const int excess = sums[0];

  for (int i = lid; i < 256; i += lsize) curve[i] = min(h[i], limit) + excess / 256.0f;
  barrier(CLK_LOCAL_MEM_FENCE);
  scan256_float(curve, scratch);
  for (int i = lid; i < 256; i += lsize) luts[tile * 256 + i] = total ? curve[i] / total : i / 255.0f;
}

__kernel void clahe_apply(__global const uchar4 *src,
                          __global const float *luts,
                          __global uchar4 *dst,
                          const int width,
                          const int height,
                          const int tiles_x,
                          const int tiles_y,
                          const float amount)
{
  GUARD;
  const int bin = luma_bin(src[i]);
  // Position in tile units, relative to the tile centres.
  const float fx = (x + 0.5f) * tiles_x / width - 0.5f;
  const float fy = (y + 0.5f) * tiles_y / height - 0.5f;
  const int tx0 = clamp((int)floor(fx), 0, tiles_x - 1);
  const int ty0 = clamp((int)floor(fy), 0, tiles_y - 1);
  const int tx1 = min(tx0 + 1, tiles_x - 1);
  const int ty1 = min(ty0 + 1, tiles_y - 1);
  const float ax = clamp(fx - tx0, 0.0f, 1.0f);
  const float ay = clamp(fy - ty0, 0.0f, 1.0f);
  const float v00 = luts[(ty0 * tiles_x + tx0) * 256 + bin];
  const float v10 = luts[(ty0 * tiles_x + tx1) * 256 + bin];
  const float v01 = luts[(ty1 * tiles_x + tx0) * 256 + bin];
  const float v11 = luts[(ty1 * tiles_x + tx1) * 256 + bin];
  const float v = mix(mix(v00, v10, ax), mix(v01, v11, ax), ay);
  const float3 c = to_rgb(src[i]);
  dst[i] = from_rgb(mix(c, with_luma(c, v), amount), src[i].w);
}
