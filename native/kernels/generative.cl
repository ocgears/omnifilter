// Showpieces: algorithms that are natural on a GPU but awkward elsewhere.

// ---- Stained glass: Voronoi cells with the Jump Flooding Algorithm ----------
// Each pixel needs to know its nearest seed point. Checking every seed per
// pixel would be far too slow; jump flooding instead passes "nearest seed so
// far" between pixels at distances n/2, n/4, ... 1, so after log2(n) passes
// every pixel knows its (approximately) nearest seed.

__kernel void jfa_clear(__global int *map, const int width, const int height)
{
  GUARD;
  map[i] = -1;
}

// One work-item per seed marks the seed's own pixel.
__kernel void jfa_plant(__global const int2 *seeds,
                        __global int *map,
                        const int width,
                        const int height,
                        const int count)
{
  const int s = get_global_id(0);
  if (s >= count) return;
  const int2 p = seeds[s];
  map[p.y * width + p.x] = s;
}

float seed_dist2(int2 seed, int x, int y) {
  const float dx = seed.x - x;
  const float dy = seed.y - y;
  return dx * dx + dy * dy;
}

__kernel void jfa_step(__global const int *in,
                       __global int *out,
                       __global const int2 *seeds,
                       const int width,
                       const int height,
                       const int step)
{
  GUARD;
  int best = in[i];
  float best_d = best >= 0 ? seed_dist2(seeds[best], x, y) : MAXFLOAT;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      const int nx = x + dx * step;
      const int ny = y + dy * step;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const int s = in[ny * width + nx];
      if (s < 0) continue;
      const float d = seed_dist2(seeds[s], x, y);
      if (d < best_d) {
        best_d = d;
        best = s;
      }
    }
  }
  out[i] = best;
}

// Each cell's sums are CELL_SUMS uints: colour times alpha for red, green and
// blue, then alpha, each as a 64-bit (low, high) pair so they can't overflow
// however big the cells get, then the pixel count.
#define CELL_SUMS 9

// Adds to a 64-bit (low, high) pair of uints with 32-bit atomics: whoever
// makes the low word wrap round carries one into the high word.
void atomic_add_u64(volatile __global uint *pair, uint value) {
  const uint old = atomic_add(pair, value);
  if (old + value < old) atomic_inc(pair + 1);
}

float read_u64(__global const uint *pair) {
  return pair[1] * 4294967296.0f + pair[0];
}

// Sums every cell's colour with atomic adds, so each cell can be filled with
// its average colour. Colours are weighted by alpha, so transparent pixels
// add nothing to the colour, only to the cell's mean alpha.
__kernel void cell_accumulate(__global const uchar4 *src,
                              __global const int *map,
                              volatile __global uint *sums,
                              const int width,
                              const int height)
{
  GUARD;
  const int s = map[i];
  if (s < 0) return;
  const uint4 p = convert_uint4(src[i]);
  volatile __global uint *cell = sums + s * CELL_SUMS;
  if (p.w) {
    atomic_add_u64(cell + 0, p.x * p.w);
    atomic_add_u64(cell + 2, p.y * p.w);
    atomic_add_u64(cell + 4, p.z * p.w);
    atomic_add_u64(cell + 6, p.w);
  }
  atomic_inc(cell + 8);
}

// Fills cells with their average colour and mean alpha, and draws dark lead
// lines wherever a neighbour within line_width pixels belongs to another cell.
__kernel void stained_glass(__global const int *map,
                            __global const uint *sums,
                            __global uchar4 *dst,
                            const int width,
                            const int height,
                            const float line_width)
{
  GUARD;
  const int s = map[i];
  __global const uint *cell = sums + s * CELL_SUMS;
  const float alpha_sum = read_u64(cell + 6);
  const float n = max(cell[8], 1u);
  float3 c = alpha_sum > 0.0f ?
    (float3)(read_u64(cell), read_u64(cell + 2), read_u64(cell + 4)) / (255.0f * alpha_sum) : (float3)(0.0f);

  float edge = 0.0f;
  for (int a = 0; a < 8; a++) {
    const float angle = a * PI / 4.0f;
    for (int r = 1; r <= 2; r++) {
      const float dist = line_width * r * 0.5f;
      const int nx = clamp((int)(x + cos(angle) * dist + 0.5f), 0, width - 1);
      const int ny = clamp((int)(y + sin(angle) * dist + 0.5f), 0, height - 1);
      if (map[ny * width + nx] != s) edge = max(edge, r == 1 ? 1.0f : 0.35f);
    }
  }
  // Slightly richer glass, then the lead.
  const float l = luma(c);
  c = clamp(l + (c - l) * 1.25f, 0.0f, 1.0f);
  c = mix(c, (float3)(0.06f, 0.06f, 0.07f), edge);
  dst[i] = from_rgb(c, convert_uchar_sat_rte(alpha_sum / n));
}

// ---- Reaction-diffusion (Gray-Scott) -----------------------------------------
// Two virtual chemicals, U and V, spread at different rates and react
// (U + 2V -> 3V). Thousands of tiny steps grow organic patterns: spots,
// stripes, mazes or coral, depending on the feed and kill rates. The photo's
// brightness nudges the kill rate, so the pattern follows the picture. The
// simulation runs on a smaller grid (gw x gh); state is (U, V, feed, kill).

__kernel void rd_init(read_only image2d_t src,
                      __global float4 *state,
                      const int gw,
                      const int gh,
                      const int width,
                      const int height,
                      const float feed,
                      const float kill,
                      const float kill_range,
                      const int seed)
{
  const int x = get_global_id(0);
  const int y = get_global_id(1);
  if (x >= gw || y >= gh) return;
  const float2 p = (float2)((x + 0.5f) * width / gw, (y + 0.5f) * height / gh);
  const float l = luma(sample_rgba(src, p).xyz);
  // Seed V in scattered 3x3 blocks.
  const uint h = hash3(x / 3, y / 3, seed);
  const float v = (h & 0xffff) < 0xffff * 0.08f ? 1.0f : 0.0f;
  state[y * gw + x] = (float4)(1.0f - 0.5f * v, v, feed, kill + (l - 0.5f) * kill_range);
}

__kernel void rd_step(__global const float4 *in,
                      __global float4 *out,
                      const int gw,
                      const int gh,
                      const float du,
                      const float dv,
                      const float dt)
{
  const int x = get_global_id(0);
  const int y = get_global_id(1);
  if (x >= gw || y >= gh) return;
  const int xl = max(x - 1, 0), xr = min(x + 1, gw - 1);
  const int yu = max(y - 1, 0), yd = min(y + 1, gh - 1);
  const float4 c = in[y * gw + x];
  // 3x3 Laplacian: how much each chemical differs from its neighbours.
  const float2 lap =
      0.2f * (in[y * gw + xl].xy + in[y * gw + xr].xy + in[yu * gw + x].xy + in[yd * gw + x].xy) +
      0.05f * (in[yu * gw + xl].xy + in[yu * gw + xr].xy + in[yd * gw + xl].xy + in[yd * gw + xr].xy) -
      c.xy;
  const float u = c.x, v = c.y, f = c.z, k = c.w;
  const float uvv = u * v * v;
  const float nu = u + (du * lap.x - uvv + f * (1.0f - u)) * dt;
  const float nv = v + (dv * lap.y + uvv - (k + f) * v) * dt;
  out[y * gw + x] = (float4)(clamp(nu, 0.0f, 1.0f), clamp(nv, 0.0f, 1.0f), f, k);
}

// Draws the pattern at full size, reading the simulation grid as a float
// texture so it's smoothly interpolated. mode 0 is ink on paper; mode 1
// reveals the photo's colours through the pattern. Either way the photo's
// alpha is kept.
__kernel void rd_render(read_only image2d_t state,
                        read_only image2d_t src,
                        __global uchar4 *dst,
                        const int width,
                        const int height,
                        const int gw,
                        const int gh,
                        const int mode)
{
  GUARD;
  const float2 gp = (float2)((x + 0.5f) * gw / width, (y + 0.5f) * gh / height);
  const float v = read_imagef(state, LINEAR, gp).y;
  const float t = smoothstep(0.15f, 0.35f, v);
  const float4 photo = read_imagef(src, NEAREST, (float2)(x + 0.5f, y + 0.5f));
  float3 o;
  if (mode == 0) {
    o = mix((float3)(0.96f, 0.94f, 0.88f), (float3)(0.1f, 0.12f, 0.2f), t);
  } else {
    const float3 c = photo.xyz;
    const float l = luma(c);
    const float3 vivid = clamp(l + (c - l) * 1.4f, 0.0f, 1.0f);
    o = mix(c * 0.12f, vivid, t);
  }
  dst[i] = from_rgb(o, convert_uchar_sat_rte(photo.w * 255.0f));
}
