// Per-pixel colour operations. Each output pixel depends only on the same
// input pixel, so these are limited by memory speed rather than maths.

// Multiplies each pixel by a 4x5 colour matrix (the same idea as CSS/SVG
// feColorMatrix). The fifth column is an offset. Grayscale, sepia, invert,
// saturation, hue rotation, brightness, contrast and channel swaps are all
// just different matrices, built in server/lib/filters/colour.js.
__kernel void color_matrix(__global const uchar4 *src,
                           __global uchar4 *dst,
                           const int width,
                           const int height,
                           __global const float *m)
{
  GUARD;
  const float4 c = convert_float4(src[i]) * (1.0f / 255.0f);
  const float4 o = (float4)(
    m[0] * c.x + m[1] * c.y + m[2] * c.z + m[3] * c.w + m[4],
    m[5] * c.x + m[6] * c.y + m[7] * c.z + m[8] * c.w + m[9],
    m[10] * c.x + m[11] * c.y + m[12] * c.z + m[13] * c.w + m[14],
    m[15] * c.x + m[16] * c.y + m[17] * c.z + m[18] * c.w + m[19]);
  dst[i] = from_rgba(o);
}

__kernel void gamma_correct(__global const uchar4 *src,
                            __global uchar4 *dst,
                            const int width,
                            const int height,
                            const float gamma)
{
  GUARD;
  dst[i] = from_rgb(pow(to_rgb(src[i]), 1.0f / gamma), src[i].w);
}

// Pure black and white, split at a brightness threshold.
__kernel void threshold(__global const uchar4 *src,
                        __global uchar4 *dst,
                        const int width,
                        const int height,
                        const float level)
{
  GUARD;
  const float v = luma(to_rgb(src[i])) >= level ? 1.0f : 0.0f;
  dst[i] = from_rgb((float3)(v), src[i].w);
}

// Reduces each channel to a few evenly spaced levels.
__kernel void posterize(__global const uchar4 *src,
                        __global uchar4 *dst,
                        const int width,
                        const int height,
                        const int levels)
{
  GUARD;
  const float n = levels - 1;
  dst[i] = from_rgb(round(to_rgb(src[i]) * n) / n, src[i].w);
}

// Inverts tones above the threshold, like over-exposing film to light.
__kernel void solarize(__global const uchar4 *src,
                       __global uchar4 *dst,
                       const int width,
                       const int height,
                       const float level)
{
  GUARD;
  const float3 c = to_rgb(src[i]);
  dst[i] = from_rgb(select(c, 1.0f - c, isgreater(c, (float3)(level))), src[i].w);
}

// Maps brightness onto a gradient between two colours.
__kernel void duotone(__global const uchar4 *src,
                      __global uchar4 *dst,
                      const int width,
                      const int height,
                      const float sr, const float sg, const float sb,
                      const float hr, const float hg, const float hb)
{
  GUARD;
  const float l = luma(to_rgb(src[i]));
  dst[i] = from_rgb(mix((float3)(sr, sg, sb), (float3)(hr, hg, hb), l), src[i].w);
}

// Darkens towards the corners. Distance is measured from the centre, scaled
// so the corners are at 1.
__kernel void vignette(__global const uchar4 *src,
                       __global uchar4 *dst,
                       const int width,
                       const int height,
                       const float strength,
                       const float radius,
                       const float softness)
{
  GUARD;
  const float2 d = (float2)(x + 0.5f - width * 0.5f, y + 0.5f - height * 0.5f);
  const float dist = length(d) / (0.5f * sqrt((float)width * width + (float)height * height));
  const float f = 1.0f - strength * smoothstep(radius, radius + softness, dist);
  dst[i] = from_rgb(to_rgb(src[i]) * f, src[i].w);
}

// Colour grading with a 3D lookup table: a cube of size^3 colours that says
// what every input colour should become. The table lives in a 3D image, so
// the texture hardware interpolates between its entries (trilinearly) for
// free. Red runs along x, green along y and blue along z, as in .cube files.
// domain holds the input colours at the cube's first and last entries (red,
// green and blue minimums, then maximums), usually 0 0 0 and 1 1 1; colours
// outside it take the nearest entry.
__kernel void lut3d(__global const uchar4 *src,
                    __global uchar4 *dst,
                    const int width,
                    const int height,
                    read_only image3d_t lut,
                    const int size,
                    const float amount,
                    __global const float *domain)
{
  GUARD;
  const float3 c = to_rgb(src[i]);
  const float3 lo = (float3)(domain[0], domain[1], domain[2]);
  const float3 hi = (float3)(domain[3], domain[4], domain[5]);
  const float3 coord = clamp((c - lo) / (hi - lo), 0.0f, 1.0f) * (size - 1) + 0.5f;
  const float4 graded = read_imagef(lut, LINEAR, (float4)(coord, 0.0f));
  dst[i] = from_rgb(mix(c, graded.xyz, amount), src[i].w);
}
