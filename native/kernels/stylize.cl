// Nonlinear neighbourhood filters. These do a lot of maths per pixel, which
// is where a GPU's thousands of parallel threads pay off most.

float luma_at(__global const uchar4 *img, int x, int y, int width, int height) {
  return luma(rgb_at(img, x, y, width, height));
}

// Sobel edge detection: the brightness gradient in x and y, from 3x3
// neighbourhoods. mode 0 draws white edges on black, 1 dark lines on white,
// and 2 colours each edge by its direction ("neon").
__kernel void sobel(__global const uchar4 *src,
                    __global uchar4 *dst,
                    const int width,
                    const int height,
                    const float scale,
                    const int mode)
{
  GUARD;
  const float tl = luma_at(src, x - 1, y - 1, width, height);
  const float t = luma_at(src, x, y - 1, width, height);
  const float tr = luma_at(src, x + 1, y - 1, width, height);
  const float l = luma_at(src, x - 1, y, width, height);
  const float r = luma_at(src, x + 1, y, width, height);
  const float bl = luma_at(src, x - 1, y + 1, width, height);
  const float b = luma_at(src, x, y + 1, width, height);
  const float br = luma_at(src, x + 1, y + 1, width, height);
  const float gx = (tr + 2.0f * r + br) - (tl + 2.0f * l + bl);
  const float gy = (bl + 2.0f * b + br) - (tl + 2.0f * t + tr);
  const float mag = clamp(sqrt(gx * gx + gy * gy) * scale, 0.0f, 1.0f);

  float3 o;
  if (mode == 0) o = (float3)(mag);
  else if (mode == 1) o = (float3)(1.0f - mag);
  else o = hsv_to_rgb(atan2(gy, gx) / (2.0f * PI) + 0.5f, 1.0f, mag);
  dst[i] = from_rgb(o, src[i].w);
}

// Colour dodge blend: brightens the base by the blend layer. Dodging a grey
// image with a blurred, inverted copy of itself leaves flat areas white and
// edges dark, which looks like a pencil sketch.
__kernel void color_dodge(__global const uchar4 *base,
                          __global const uchar4 *blend,
                          __global uchar4 *dst,
                          const int width,
                          const int height)
{
  GUARD;
  const float3 b = to_rgb(base[i]);
  const float3 l = to_rgb(blend[i]);
  dst[i] = from_rgb(min(b / max(1.0f - l, 1e-3f), 1.0f), base[i].w);
}

// Bilateral filter: a blur that preserves edges. Each neighbour is weighted by
// how close it is (sigma_s, in pixels) and by how similar its colour is
// (sigma_r), so pixels across an edge barely contribute. It works on
// premultiplied colour, with alpha in the colour distance, so transparent
// pixels add no colour and alpha edges are preserved like colour edges.
__kernel void bilateral(__global const uchar4 *src,
                        __global uchar4 *dst,
                        const int width,
                        const int height,
                        const int radius,
                        const float sigma_s,
                        const float sigma_r,
                        const int row0)
{
  GUARD_BAND;
  const float4 c0 = premul_pixel(src[i]);
  const float ks = -0.5f / (sigma_s * sigma_s);
  const float kr = -0.5f / (sigma_r * sigma_r);
  float4 sum = (float4)(0.0f);
  float wsum = 0.0f;
  for (int dy = -radius; dy <= radius; dy++) {
    for (int dx = -radius; dx <= radius; dx++) {
      const float4 c = premul_pixel(pixel_at(src, x + dx, y + dy, width, height));
      const float4 d = c - c0;
      const float w = exp((dx * dx + dy * dy) * ks + dot(d, d) * kr);
      sum += c * w;
      wsum += w;
    }
  }
  dst[i] = from_rgba(unpremultiply(sum / wsum));
}

// ---- Cartoon ------------------------------------------------------------------
// After Winnemoller et al., "Real-Time Video Abstraction" (2006).

// Soft luma quantization: bands brightness into a few levels with smooth
// (tanh) steps between them, keeping each pixel's colour.
__kernel void quantize_luma(__global const uchar4 *src,
                            __global uchar4 *dst,
                            const int width,
                            const int height,
                            const int levels,
                            const float sharpness)
{
  GUARD;
  const float3 c = to_rgb(src[i]);
  const float l = luma(c);
  const float step = 1.0f / levels;
  const float nearest = step * round(l / step);
  const float q = nearest + 0.5f * step * tanh(sharpness * (l - nearest) / step);
  dst[i] = from_rgb(with_luma(c, q), src[i].w);
}

// Ink lines from a difference of Gaussians: where the image is darker than
// its wider surroundings (the dark side of an edge). Writes the ink amount as
// grey (white = full ink).
__kernel void dog_lines(__global const uchar4 *narrow,
                        __global const uchar4 *wide,
                        __global uchar4 *dst,
                        const int width,
                        const int height,
                        const float threshold,
                        const float sharpness)
{
  GUARD;
  const float d = luma(to_rgb(narrow[i])) - luma(to_rgb(wide[i]));
  const float ink = clamp((-d - threshold) * sharpness, 0.0f, 1.0f);
  dst[i] = from_rgb((float3)(ink), 255);
}

__kernel void cartoon_combine(__global const uchar4 *colour,
                              __global const uchar4 *ink,
                              __global uchar4 *dst,
                              const int width,
                              const int height)
{
  GUARD;
  const float k = ink[i].x / 255.0f;
  dst[i] = from_rgb(to_rgb(colour[i]) * (1.0f - k), colour[i].w);
}

// Kuwahara filter: looks at the four overlapping squares that have this pixel
// as a corner and outputs the mean colour of the least varied one. Flat areas
// become flat brush strokes while edges stay sharp. Colours are premultiplied
// and alpha counts towards the variance, so a square straddling an alpha edge
// is avoided and transparent pixels add no colour.
__kernel void kuwahara(__global const uchar4 *src,
                       __global uchar4 *dst,
                       const int width,
                       const int height,
                       const int radius,
                       const int row0)
{
  GUARD_BAND;
  float4 sum[4], sum2[4];
  for (int q = 0; q < 4; q++) {
    sum[q] = (float4)(0.0f);
    sum2[q] = (float4)(0.0f);
  }
  for (int dy = -radius; dy <= radius; dy++) {
    for (int dx = -radius; dx <= radius; dx++) {
      const float4 c = premul_pixel(pixel_at(src, x + dx, y + dy, width, height));
      const float4 c2 = c * c;
      if (dx <= 0 && dy <= 0) { sum[0] += c; sum2[0] += c2; }
      if (dx >= 0 && dy <= 0) { sum[1] += c; sum2[1] += c2; }
      if (dx <= 0 && dy >= 0) { sum[2] += c; sum2[2] += c2; }
      if (dx >= 0 && dy >= 0) { sum[3] += c; sum2[3] += c2; }
    }
  }
  const float n = (radius + 1) * (radius + 1);
  float best = MAXFLOAT;
  float4 out = (float4)(0.0f);
  for (int q = 0; q < 4; q++) {
    const float4 mean = sum[q] / n;
    const float4 var = sum2[q] / n - mean * mean;
    const float v = var.x + var.y + var.z + var.w;
    if (v < best) {
      best = v;
      out = mean;
    }
  }
  dst[i] = from_rgba(unpremultiply(out));
}

// Median filter: the middle value of each channel in a square window, which
// removes speckle noise without blurring edges. Instead of sorting, it finds
// the median one bit at a time (a radix select): for each bit from the top,
// count how many values are below the candidate and keep the bit if the
// median must be at least that big. That's 8 passes over the window, with no
// per-pixel arrays, which suits GPUs. Alpha is a channel like the others, but
// fully transparent pixels are left out of the colour channels' medians.
__kernel void median(__global const uchar4 *src,
                     __global uchar4 *dst,
                     const int width,
                     const int height,
                     const int radius,
                     const int row0)
{
  GUARD_BAND;
  const int side = 2 * radius + 1;
  const uint k = (side * side) / 2;
  uint visible = 0;
  for (int dy = -radius; dy <= radius; dy++) {
    for (int dx = -radius; dx <= radius; dx++) visible += (uint)(pixel_at(src, x + dx, y + dy, width, height).w > 0);
  }
  if (!visible) {
    dst[i] = (uchar4)(0);
    return;
  }
  const uint kc = visible / 2;
  uint4 m = (uint4)(0);
  for (int bit = 7; bit >= 0; bit--) {
    const uint4 cand = m | (1u << bit);
    uint4 below = (uint4)(0);
    for (int dy = -radius; dy <= radius; dy++) {
      for (int dx = -radius; dx <= radius; dx++) {
        const uint4 p = convert_uint4(pixel_at(src, x + dx, y + dy, width, height));
        const uint shown = (uint)(p.w > 0);
        below += (uint4)((uint)(p.x < cand.x) & shown, (uint)(p.y < cand.y) & shown,
                         (uint)(p.z < cand.z) & shown, (uint)(p.w < cand.w));
      }
    }
    if (below.x <= kc) m.x = cand.x;
    if (below.y <= kc) m.y = cand.y;
    if (below.z <= kc) m.z = cand.z;
    if (below.w <= k) m.w = cand.w;
  }
  dst[i] = convert_uchar4(m);
}

// Crosshatching: layers of diagonal pencil lines, with more layers in
// darker areas. spacing and line_width are in pixels. With colour set, the
// lines take the photo's colour instead of graphite grey.
float hatch(float v, float spacing, float line_width) {
  const float d = fabs(v - spacing * round(v / spacing));
  return 1.0f - smoothstep(line_width * 0.5f - 0.5f, line_width * 0.5f + 0.5f, d);
}

__kernel void crosshatch(__global const uchar4 *src,
                         __global uchar4 *dst,
                         const int width,
                         const int height,
                         const float spacing,
                         const float line_width,
                         const int colour)
{
  GUARD;
  const float3 c = to_rgb(src[i]);
  const float l = luma(c);
  const float a = (x + y) * 0.70710678f;
  const float b = (x - y) * 0.70710678f;
  float ink = 0.0f;
  if (l < 0.85f) ink = max(ink, hatch(a, spacing, line_width));
  if (l < 0.65f) ink = max(ink, hatch(b, spacing, line_width));
  if (l < 0.45f) ink = max(ink, hatch(a + spacing * 0.5f, spacing, line_width));
  if (l < 0.25f) ink = max(ink, hatch(b + spacing * 0.5f, spacing, line_width));
  const float3 paper = (float3)(0.98f, 0.96f, 0.91f);
  const float3 pen = colour ? c * 0.7f : (float3)(0.12f, 0.12f, 0.16f);
  dst[i] = from_rgb(mix(paper, pen, ink), src[i].w);
}

// ---- Oil paint: anisotropic Kuwahara filter --------------------------------
// After Kyprianidis et al., "Anisotropic Kuwahara Filtering with Polynomial
// Weighting Functions" (2011). Instead of four squares, it uses an ellipse
// aligned with the local edge direction, split into eight overlapping
// sectors, so brush strokes follow the shapes in the picture.
//
// Pass 1: the structure tensor, which captures the local gradient direction.
__kernel void structure_tensor(__global const uchar4 *src,
                               __global float4 *tensor,
                               const int width,
                               const int height)
{
  GUARD;
  const float3 fx = (rgb_at(src, x + 1, y - 1, width, height) + 2.0f * rgb_at(src, x + 1, y, width, height) +
                     rgb_at(src, x + 1, y + 1, width, height) - rgb_at(src, x - 1, y - 1, width, height) -
                     2.0f * rgb_at(src, x - 1, y, width, height) - rgb_at(src, x - 1, y + 1, width, height)) * 0.25f;
  const float3 fy = (rgb_at(src, x - 1, y + 1, width, height) + 2.0f * rgb_at(src, x, y + 1, width, height) +
                     rgb_at(src, x + 1, y + 1, width, height) - rgb_at(src, x - 1, y - 1, width, height) -
                     2.0f * rgb_at(src, x, y - 1, width, height) - rgb_at(src, x + 1, y - 1, width, height)) * 0.25f;
  tensor[i] = (float4)(dot(fx, fx), dot(fx, fy), dot(fy, fy), 0.0f);
}

// Pass 2 (after smoothing the tensor): the edge direction and how strongly
// directional (anisotropic) the neighbourhood is, from its eigenvalues.
__kernel void tensor_orientation(__global const float4 *tensor,
                                 __global float4 *orient,
                                 const int width,
                                 const int height)
{
  GUARD;
  const float4 g = tensor[i];
  const float root = sqrt((g.x - g.z) * (g.x - g.z) + 4.0f * g.y * g.y);
  const float lambda1 = 0.5f * (g.x + g.z + root);
  const float lambda2 = 0.5f * (g.x + g.z - root);
  const float2 v = (float2)(lambda1 - g.x, -g.y);
  const float2 t = length(v) > 0.0f ? normalize(v) : (float2)(0.0f, 1.0f);
  const float phi = -atan2(t.y, t.x);
  const float a = lambda1 + lambda2 > 0.0f ? (lambda1 - lambda2) / (lambda1 + lambda2) : 0.0f;
  orient[i] = (float4)(t, phi, a);
}

// Pass 3: the filter itself. Samples are weighted by alpha, so transparent
// pixels add no colour, and each pixel keeps its own alpha.
__kernel void anisotropic_kuwahara(__global const uchar4 *src,
                                   __global const float4 *orient,
                                   __global uchar4 *dst,
                                   const int width,
                                   const int height,
                                   const float radius,
                                   const float q,
                                   const float alpha,
                                   const int row0)
{
  GUARD_BAND;
  float4 m[8];
  float3 s[8];
  for (int k = 0; k < 8; k++) {
    m[k] = (float4)(0.0f);
    s[k] = (float3)(0.0f);
  }

  const float4 o = orient[i];
  const float a = radius * clamp((alpha + o.w) / alpha, 0.1f, 2.0f);
  const float b = radius * clamp(alpha / (alpha + o.w), 0.1f, 2.0f);
  const float cos_phi = cos(o.z);
  const float sin_phi = sin(o.z);
  // Maps the ellipse onto a disc of radius 0.5.
  const float2 sr0 = (float2)(cos_phi, sin_phi) * (0.5f / a);
  const float2 sr1 = (float2)(-sin_phi, cos_phi) * (0.5f / b);
  const int max_x = (int)sqrt(a * a * cos_phi * cos_phi + b * b * sin_phi * sin_phi);
  const int max_y = (int)sqrt(a * a * sin_phi * sin_phi + b * b * cos_phi * cos_phi);

  const float zeta = 2.0f / radius;
  const float zero_cross = 3.0f * PI / 8.0f;
  const float sin_zc = sin(zero_cross);
  const float eta = (zeta + cos(zero_cross)) / (sin_zc * sin_zc);

  // Big brushes sample every other pixel: the smooth sector weights make the
  // difference hard to see, and it's 4x less work.
  const int stride = radius > 4.0f ? 2 : 1;
  for (int j = -max_y; j <= max_y; j += stride) {
    for (int k = -max_x; k <= max_x; k += stride) {
      float2 v = (float2)(dot(sr0, (float2)(k, j)), dot(sr1, (float2)(k, j)));
      if (dot(v, v) > 0.25f) continue;
      const uchar4 px = pixel_at(src, x + k, y + j, width, height);
      if (!px.w) continue;
      const float3 c = to_rgb(px);
      float w[8];
      float sum = 0.0f;
      float vxx = zeta - eta * v.x * v.x;
      float vyy = zeta - eta * v.y * v.y;
      float z;
      z = max(0.0f, v.y + vxx); w[0] = z * z; sum += w[0];
      z = max(0.0f, -v.x + vyy); w[2] = z * z; sum += w[2];
      z = max(0.0f, -v.y + vxx); w[4] = z * z; sum += w[4];
      z = max(0.0f, v.x + vyy); w[6] = z * z; sum += w[6];
      v = 0.70710678f * (float2)(v.x - v.y, v.x + v.y);
      vxx = zeta - eta * v.x * v.x;
      vyy = zeta - eta * v.y * v.y;
      z = max(0.0f, v.y + vxx); w[1] = z * z; sum += w[1];
      z = max(0.0f, -v.x + vyy); w[3] = z * z; sum += w[3];
      z = max(0.0f, -v.y + vxx); w[5] = z * z; sum += w[5];
      z = max(0.0f, v.x + vyy); w[7] = z * z; sum += w[7];
      const float g = exp(-3.125f * dot(v, v)) / sum * (px.w * (1.0f / 255.0f));
      for (int n = 0; n < 8; n++) {
        const float wk = w[n] * g;
        m[n] += (float4)(c * wk, wk);
        s[n] += c * c * wk;
      }
    }
  }

  float4 out = (float4)(0.0f);
  for (int n = 0; n < 8; n++) {
    if (m[n].w <= 0.0f) continue;
    const float3 mean = m[n].xyz / m[n].w;
    const float3 var = fabs(s[n] / m[n].w - mean * mean);
    const float sigma2 = var.x + var.y + var.z;
    const float wn = 1.0f / (1.0f + pow(255.0f * sigma2, 0.5f * q));
    out += (float4)(mean * wn, wn);
  }
  dst[i] = from_rgb(out.w > 0.0f ? out.xyz / out.w : (float3)(0.0f), src[i].w);
}
