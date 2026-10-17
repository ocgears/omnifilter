// Retro looks: blocks, dots, dithering and text.

// Averages each block x block tile into one float4 (0-255), with one
// work-item per tile. Shared by pixelate and ASCII art. Tiles at the right
// and bottom edges may be partial. The average is premultiplied, so
// transparent pixels add no colour: the result is the visible pixels' mean
// colour (straight alpha), with the tile's mean alpha.
__kernel void block_average(__global const uchar4 *src,
                            __global float4 *avg,
                            const int width,
                            const int height,
                            const int block,
                            const int blocks_x,
                            const int blocks_y)
{
  const int bx = get_global_id(0);
  const int by = get_global_id(1);
  if (bx >= blocks_x || by >= blocks_y) return;
  const int x0 = bx * block;
  const int y0 = by * block;
  const int x1 = min(x0 + block, width);
  const int y1 = min(y0 + block, height);
  float4 sum = (float4)(0.0f);
  for (int y = y0; y < y1; y++) {
    for (int x = x0; x < x1; x++) {
      const float4 p = convert_float4(src[y * width + x]);
      sum += (float4)(p.xyz * p.w, p.w);
    }
  }
  avg[by * blocks_x + bx] = sum.w > 0.0f ?
    (float4)(sum.xyz / sum.w, sum.w / (float)((x1 - x0) * (y1 - y0))) : (float4)(0.0f);
}

__kernel void pixelate_fill(__global const float4 *avg,
                            __global uchar4 *dst,
                            const int width,
                            const int height,
                            const int block,
                            const int blocks_x)
{
  GUARD;
  dst[i] = convert_uchar4_sat_rte(avg[(y / block) * blocks_x + x / block]);
}

// Ordered dithering with an 8x8 Bayer matrix: adds a fixed, finely varied
// threshold pattern before quantizing, so a few colours can fake many.
// Unlike error diffusion (Floyd-Steinberg), every pixel is independent,
// which suits a GPU. mode 0 quantizes each channel to `levels` levels,
// mode 1 is greyscale, and mode 2 uses the original Game Boy's four greens.
__constant float BAYER8[64] = {
   0, 32,  8, 40,  2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37,
  63, 31, 55, 23, 61, 29, 53, 21
};

__kernel void dither(__global const uchar4 *src,
                     __global uchar4 *dst,
                     const int width,
                     const int height,
                     const int levels,
                     const int pixel,
                     const int mode)
{
  GUARD;
  const int bx = (x / pixel) & 7;
  const int by = (y / pixel) & 7;
  const float t = (BAYER8[by * 8 + bx] + 0.5f) / 64.0f - 0.5f;
  const float3 c = to_rgb(src[i]);
  float3 o;
  if (mode == 0) {
    const float n = levels - 1;
    o = clamp(floor(c * n + t + 0.5f), 0.0f, n) / n;
  } else if (mode == 1) {
    const float n = levels - 1;
    o = (float3)(clamp(floor(luma(c) * n + t + 0.5f), 0.0f, n) / n);
  } else {
    const int shade = (int)clamp(floor(luma(c) * 3.0f + t + 0.5f), 0.0f, 3.0f);
    o = shade == 0 ? (float3)(0.059f, 0.220f, 0.059f)
      : shade == 1 ? (float3)(0.188f, 0.384f, 0.188f)
      : shade == 2 ? (float3)(0.545f, 0.675f, 0.059f)
      : (float3)(0.608f, 0.737f, 0.059f);
  }
  dst[i] = from_rgb(o, src[i].w);
}

// ---- Halftone ---------------------------------------------------------------
// Printing-press dots: a grid of dots per ink, each rotated to its own screen
// angle, with dot size set by how much of that ink the area needs. Reads a
// pre-blurred image (as a texture) at each dot's centre. The paper takes the
// original image's alpha, so cut-outs stay cut out.

float4 rgb_to_cmyk(float3 c) {
  const float k = 1.0f - max(c.x, max(c.y, c.z));
  if (k >= 1.0f) return (float4)(0.0f, 0.0f, 0.0f, 1.0f);
  return (float4)((1.0f - c - k) / (1.0f - k), k);
}

// Coverage (0-1) of this pixel by the dots of one ink (channel 0-3 = CMYK).
float halftone_ink(read_only image2d_t img, float2 p, float angle, float cell, int channel) {
  const float ca = cos(angle);
  const float sa = sin(angle);
  const float2 r = (float2)(ca * p.x + sa * p.y, -sa * p.x + ca * p.y);
  const float2 base = floor(r / cell);
  float best = 0.0f;
  // Dark areas have dots bigger than their cell, so check the neighbours too.
  for (int oy = -1; oy <= 1; oy++) {
    for (int ox = -1; ox <= 1; ox++) {
      const float2 centre = (base + (float2)(ox, oy) + 0.5f) * cell;
      const float2 image_pos = (float2)(ca * centre.x - sa * centre.y, sa * centre.x + ca * centre.y);
      const float4 cmyk = rgb_to_cmyk(sample_rgba(img, image_pos).xyz);
      const float ink = channel == 0 ? cmyk.x : channel == 1 ? cmyk.y : channel == 2 ? cmyk.z : cmyk.w;
      const float radius = sqrt(ink) * cell * 0.70710678f;
      const float d = length(r - centre);
      best = max(best, 1.0f - smoothstep(radius - 0.75f, radius + 0.75f, d));
    }
  }
  return best;
}

__kernel void halftone(read_only image2d_t src,
                       __global uchar4 *dst,
                       const int width,
                       const int height,
                       const float cell,
                       const int mono,
                       __global const uchar4 *original,
                       const int row0)
{
  GUARD_BAND;
  const float2 p = (float2)(x + 0.5f, y + 0.5f);
  float3 o = (float3)(1.0f);
  if (mono) {
    // Black ink only, at 45 degrees, sized by darkness.
    const float ca = 0.70710678f;
    const float2 r = (float2)(ca * (p.x + p.y), ca * (p.y - p.x));
    const float2 base = floor(r / cell);
    float best = 0.0f;
    for (int oy = -1; oy <= 1; oy++) {
      for (int ox = -1; ox <= 1; ox++) {
        const float2 centre = (base + (float2)(ox, oy) + 0.5f) * cell;
        const float2 image_pos = (float2)(ca * (centre.x - centre.y), ca * (centre.x + centre.y));
        const float ink = 1.0f - luma(sample_rgba(src, image_pos).xyz);
        const float radius = sqrt(ink) * cell * 0.70710678f;
        best = max(best, 1.0f - smoothstep(radius - 0.75f, radius + 0.75f, length(r - centre)));
      }
    }
    o = (float3)(1.0f - best);
  } else {
    // Cyan absorbs red, magenta green, yellow blue; black absorbs everything.
    o.x *= 1.0f - halftone_ink(src, p, 15.0f * PI / 180.0f, cell, 0);
    o.y *= 1.0f - halftone_ink(src, p, 75.0f * PI / 180.0f, cell, 1);
    o.z *= 1.0f - halftone_ink(src, p, 0.0f, cell, 2);
    o *= 1.0f - halftone_ink(src, p, 45.0f * PI / 180.0f, cell, 3);
  }
  dst[i] = from_rgb(o, original[i].w);
}

// ---- ASCII art --------------------------------------------------------------
// Each cell x cell tile becomes one character from an 8x8 bitmap font,
// chosen by the tile's brightness (glyphs are ordered sparse to dense).
// mode 0 draws glyphs in the tile's colour on black, 1 is a green terminal,
// and 2 is black ink on white paper (dense glyphs for dark areas). Each tile
// takes its mean alpha, so transparent areas stay transparent.
__kernel void ascii_art(__global const float4 *avg,
                        __global const uchar *glyphs,
                        __global uchar4 *dst,
                        const int width,
                        const int height,
                        const int cell,
                        const int blocks_x,
                        const int glyph_count,
                        const int mode)
{
  GUARD;
  const float4 tile = avg[(y / cell) * blocks_x + x / cell];
  const float3 c = tile.xyz / 255.0f;
  const float l = luma(c);
  const float density = mode == 2 ? 1.0f - l : l;
  const int g = min((int)(density * glyph_count), glyph_count - 1);
  const int u = (x % cell) * 8 / cell;
  const int v = (y % cell) * 8 / cell;
  const int on = (glyphs[g * 8 + v] >> (7 - u)) & 1;

  float3 o;
  if (mode == 0) {
    const float peak = max(c.x, max(c.y, c.z));
    o = on ? c / max(peak, 0.05f) : (float3)(0.0f);
  } else if (mode == 1) {
    o = on ? (float3)(0.25f, 1.0f, 0.35f) : (float3)(0.0f, 0.04f, 0.0f);
  } else {
    o = on ? (float3)(0.08f) : (float3)(0.98f, 0.97f, 0.94f);
  }
  dst[i] = from_rgb(o, convert_uchar_sat_rte(tile.w));
}
