// Convolution: each output pixel is a weighted sum of its neighbours.
//
// Blur, sharpen, emboss and edge detection are all just different weight
// matrices, built on the JS side (server/lib/filters). A separable filter like
// a Gaussian blur runs as two passes: a (k x 1) row kernel then a (1 x k)
// column kernel, which is far cheaper than a single (k x k) pass.
//
// Edges are handled by clamping sample coordinates (the border pixels are
// extended outwards), so no work-item ever reads outside the image.
// bias is added after weighting (e.g. 128 for emboss, so flat areas are grey);
// with absolute set, the magnitude of the result is used (for edge detection,
// where the sum can be negative).
//
// Transparency: with premultiply set (blurs), colour times alpha and alpha
// are filtered together and the colour divided back out, so alpha edges
// soften and hidden colours under transparent pixels never show. Otherwise
// (sharpening, emboss, edges, whose weights can be negative) the alpha
// channel is passed through and each neighbour's colour counts in proportion
// to its alpha, the rest of its weight going to this pixel's own colour, so
// transparent neighbours look like more of this pixel.
__kernel void convolve(__global const uchar4 *src,
                       __global uchar4 *dst,
                       const int width,
                       const int height,
                       __global const float *weights,
                       const int kw,
                       const int kh,
                       const float bias,
                       const int absolute,
                       const int premultiply,
                       const int row0)
{
  GUARD_BAND;
  const int rx = kw / 2;
  const int ry = kh / 2;

  if (premultiply) {
    // Colour in 0-255 times alpha in 0-1, and alpha in 0-255.
    float4 acc = (float4)(0.0f);
    for (int j = 0; j < kh; j++) {
      const int sy = clamp(y + j - ry, 0, height - 1);
      for (int k = 0; k < kw; k++) {
        const int sx = clamp(x + k - rx, 0, width - 1);
        const float4 p = convert_float4(src[sy * width + sx]);
        acc += (float4)(p.xyz * (p.w * (1.0f / 255.0f)), p.w) * weights[j * kw + k];
      }
    }
    if (absolute) acc = fabs(acc);
    const float3 c = acc.w > 0.0f ? acc.xyz * (255.0f / acc.w) : (float3)(0.0f);
    dst[i] = convert_uchar4_sat_rte((float4)(c + bias, acc.w));
    return;
  }

  const float3 c0 = convert_float3(src[i].xyz);
  float3 acc = (float3)(0.0f, 0.0f, 0.0f);
  for (int j = 0; j < kh; j++) {
    const int sy = clamp(y + j - ry, 0, height - 1);
    for (int k = 0; k < kw; k++) {
      const int sx = clamp(x + k - rx, 0, width - 1);
      const uchar4 p = src[sy * width + sx];
      acc += mix(c0, convert_float3(p.xyz), p.w * (1.0f / 255.0f)) * weights[j * kw + k];
    }
  }

  if (absolute) acc = fabs(acc);
  acc += bias;
  dst[i] = (uchar4)(convert_uchar3_sat_rte(acc), src[i].w);
}

// Shrinks an image by `factor` in each direction, averaging each block
// (premultiplied; blocks at the right and bottom may be partial). With
// upsample_bilinear, wide blurs run on a small copy: see gaussian() in
// server/lib/filters/plan.js. Runs one work-item per small pixel.
__kernel void downsample_box(__global const uchar4 *src,
                             __global uchar4 *dst,
                             const int width,
                             const int height,
                             const int small_width,
                             const int small_height,
                             const int factor)
{
  const int sx = get_global_id(0);
  const int sy = get_global_id(1);
  if (sx >= small_width || sy >= small_height) return;
  const int x0 = sx * factor;
  const int y0 = sy * factor;
  const int x1 = min(x0 + factor, width);
  const int y1 = min(y0 + factor, height);
  float4 sum = (float4)(0.0f);
  for (int y = y0; y < y1; y++) {
    for (int x = x0; x < x1; x++) sum += premul_pixel(src[y * width + x]);
  }
  dst[sy * small_width + sx] = from_rgba(unpremultiply(sum / (float)((x1 - x0) * (y1 - y0))));
}

// Scales a downsample_box result back up to width x height, interpolating
// bilinearly (premultiplied) between the small pixels' centres.
__kernel void upsample_bilinear(__global const uchar4 *small,
                                __global uchar4 *dst,
                                const int width,
                                const int height,
                                const int small_width,
                                const int small_height,
                                const int factor)
{
  GUARD;
  const float2 q = ((float2)(x + 0.5f, y + 0.5f)) / factor - 0.5f;
  const float2 f = floor(q);
  const float2 t = q - f;
  const int x0 = clamp((int)f.x, 0, small_width - 1);
  const int y0 = clamp((int)f.y, 0, small_height - 1);
  const int x1 = clamp((int)f.x + 1, 0, small_width - 1);
  const int y1 = clamp((int)f.y + 1, 0, small_height - 1);
  const float4 a = premul_pixel(small[y0 * small_width + x0]);
  const float4 b = premul_pixel(small[y0 * small_width + x1]);
  const float4 c = premul_pixel(small[y1 * small_width + x0]);
  const float4 d = premul_pixel(small[y1 * small_width + x1]);
  dst[i] = from_rgba(unpremultiply(mix(mix(a, b, t.x), mix(c, d, t.x), t.y)));
}

// The same convolution over float4 buffers, used to smooth the structure
// tensor in the oil paint filter.
__kernel void convolve_f4(__global const float4 *src,
                          __global float4 *dst,
                          const int width,
                          const int height,
                          __global const float *weights,
                          const int kw,
                          const int kh)
{
  GUARD;
  const int rx = kw / 2;
  const int ry = kh / 2;
  float4 acc = (float4)(0.0f);
  for (int j = 0; j < kh; j++) {
    const int sy = clamp(y + j - ry, 0, height - 1);
    for (int k = 0; k < kw; k++) {
      const int sx = clamp(x + k - rx, 0, width - 1);
      acc += src[sy * width + sx] * weights[j * kw + k];
    }
  }
  dst[i] = acc;
}

// Puts back the original image's alpha, for filters that blur only to
// measure something (edges, ink density) and shouldn't soften the outline.
__kernel void restore_alpha(__global const uchar4 *src,
                            __global uchar4 *dst,
                            const int width,
                            const int height,
                            __global const uchar4 *original)
{
  GUARD;
  dst[i] = (uchar4)(src[i].xyz, original[i].w);
}

// Unsharp mask: boosts the difference between the image and a blurred copy of
// it. threshold skips low-contrast detail (so noise isn't sharpened). The
// blurred copy is a premultiplied blur, so its colour near transparent areas
// comes only from visible pixels; alpha is kept.
__kernel void unsharp(__global const uchar4 *src,
                      __global const uchar4 *blurred,
                      __global uchar4 *dst,
                      const int width,
                      const int height,
                      const float amount,
                      const float threshold)
{
  GUARD;
  const float3 s = to_rgb(src[i]);
  const float3 diff = s - to_rgb(blurred[i]);
  const float mask = threshold > 0.0f ? smoothstep(threshold * 0.5f, threshold, fabs(luma(diff))) : 1.0f;
  dst[i] = from_rgb(s + amount * mask * diff, src[i].w);
}

// Motion blur: averages samples along a line through each pixel. Reading
// from an image lets it interpolate between pixels (premultiplied, see
// sample_premul), so the line can point in any direction. Heavy for long
// lines, so it can run in bands of rows.
__kernel void motion_blur(read_only image2d_t src,
                          __global uchar4 *dst,
                          const int width,
                          const int height,
                          const float dx,
                          const float dy,
                          const int samples,
                          const int row0)
{
  GUARD_BAND;
  const float2 p = (float2)(x + 0.5f, y + 0.5f);
  const float2 d = (float2)(dx, dy);
  float4 acc = (float4)(0.0f);
  for (int s = 0; s < samples; s++) {
    const float t = samples > 1 ? (float)s / (samples - 1) - 0.5f : 0.0f;
    acc += sample_premul(src, p + t * d);
  }
  dst[i] = from_rgba(unpremultiply(acc / samples));
}

// Tilt-shift: keeps a horizontal band sharp and blurs progressively above and
// below it, with boosted saturation, so scenes look like miniature models.
// The blurred copies have soft alpha edges, so the mixing is premultiplied.
__kernel void tilt_shift(__global const uchar4 *src,
                         __global const uchar4 *blur1,
                         __global const uchar4 *blur2,
                         __global uchar4 *dst,
                         const int width,
                         const int height,
                         const float focus,
                         const float band,
                         const float transition,
                         const float saturation)
{
  GUARD;
  const float ny = (y + 0.5f) / height;
  const float m = smoothstep(0.0f, 1.0f, clamp((fabs(ny - focus) - band) / transition, 0.0f, 1.0f));
  const float4 s = premul_pixel(src[i]);
  const float4 b1 = premul_pixel(blur1[i]);
  const float4 b2 = premul_pixel(blur2[i]);
  float4 c = unpremultiply(m < 0.5f ? mix(s, b1, m * 2.0f) : mix(b1, b2, m * 2.0f - 1.0f));
  const float l = luma(c.xyz);
  c.xyz = l + (c.xyz - l) * saturation;
  dst[i] = from_rgba(c);
}
