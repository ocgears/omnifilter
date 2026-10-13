// Helpers shared by every kernel file. server/lib/gpu_filters.js concatenates
// this file first, then the others in alphabetical order, into one program.
//
// Conventions used throughout:
// - Images are RGBA, 8 bits per channel, stored row by row in a buffer.
// - Most kernels run one work-item per output pixel, with the global size
//   set to (width, height), and start with GUARD.
// - Colour maths is done in floats from 0 to 1.

#define PI 3.14159265358979f

// Mesa's Rusticl crashes in sin, cos and tan, at least on llvmpipe (Mesa 25,
// LLVM 20), while sinpi and cospi work. For Rusticl devices gpu_filters.js
// compiles with OMNIFILTER_TRIG_VIA_SINPI, which routes the three through
// those instead; the results are as accurate for the angles used here.
#ifdef OMNIFILTER_TRIG_VIA_SINPI
#define sin(a) sinpi((a) * (1.0f / PI))
#define cos(a) cospi((a) * (1.0f / PI))
#define tan(a) (sinpi((a) * (1.0f / PI)) / cospi((a) * (1.0f / PI)))
#endif

// Declares x, y and i (the pixel index) and skips work-items outside the image.
#define GUARD \
  const int x = get_global_id(0); \
  const int y = get_global_id(1); \
  if (x >= width || y >= height) return; \
  const int i = y * width + x;

// For heavy kernels that may be launched in bands of rows (see `band` in
// native/omnifilter.cpp): their last argument, row0, is the band's first row.
#define GUARD_BAND \
  const int x = get_global_id(0); \
  const int y = get_global_id(1) + row0; \
  if (x >= width || y >= height) return; \
  const int i = y * width + x;

// Samplers for kernels that read images (textures). Coordinates are in
// pixels, with pixel centres at (x + 0.5, y + 0.5); reads past the edge
// return the nearest edge pixel. LINEAR makes the texture hardware blend the
// four nearest pixels (bilinear interpolation) for free.
const sampler_t LINEAR = CLK_NORMALIZED_COORDS_FALSE | CLK_ADDRESS_CLAMP_TO_EDGE | CLK_FILTER_LINEAR;
const sampler_t NEAREST = CLK_NORMALIZED_COORDS_FALSE | CLK_ADDRESS_CLAMP_TO_EDGE | CLK_FILTER_NEAREST;

float3 to_rgb(uchar4 p) {
  return convert_float3(p.xyz) * (1.0f / 255.0f);
}

uchar4 from_rgb(float3 c, uchar alpha) {
  return (uchar4)(convert_uchar3_sat_rte(c * 255.0f), alpha);
}

uchar4 from_rgba(float4 c) {
  return convert_uchar4_sat_rte(c * 255.0f);
}

// ---- Transparency ------------------------------------------------------------
// Pixels are stored with straight (non-premultiplied) alpha: a fully
// transparent pixel can hold any colour, often black. Averaging straight
// colours lets that hidden colour bleed into visible neighbours (dark halos
// round cut-outs), so anything that mixes pixels does it premultiplied:
// colour times alpha, mixed together with alpha, then divided back out.

float4 to_rgba(uchar4 p) {
  return convert_float4(p) * (1.0f / 255.0f);
}

float4 premultiply(float4 c) {
  return (float4)(c.xyz * c.w, c.w);
}

// Back to straight alpha; fully transparent results come out as (0, 0, 0, 0).
float4 unpremultiply(float4 c) {
  return c.w > 0.0f ? (float4)(c.xyz / c.w, c.w) : (float4)(0.0f);
}

// Bilinear sampling, premultiplied. The texture hardware's own LINEAR filter
// blends straight colours, so this reads the four nearest pixels itself.
float4 sample_premul(read_only image2d_t img, float2 p) {
  const float2 q = p - 0.5f;
  const float2 f = floor(q);
  const float2 t = q - f;
  const float2 c = f + 0.5f;
  const float4 a = premultiply(read_imagef(img, NEAREST, c));
  const float4 b = premultiply(read_imagef(img, NEAREST, c + (float2)(1.0f, 0.0f)));
  const float4 d = premultiply(read_imagef(img, NEAREST, c + (float2)(0.0f, 1.0f)));
  const float4 e = premultiply(read_imagef(img, NEAREST, c + (float2)(1.0f, 1.0f)));
  return mix(mix(a, b, t.x), mix(d, e, t.x), t.y);
}

// The same, back in straight alpha.
float4 sample_rgba(read_only image2d_t img, float2 p) {
  return unpremultiply(sample_premul(img, p));
}

// Rec. 709 luma: perceived brightness.
float luma(float3 c) {
  return dot(c, (float3)(0.2126f, 0.7152f, 0.0722f));
}

// Luma as an integer 0-255, for histograms.
int luma_bin(uchar4 p) {
  return clamp((int)(0.2126f * p.x + 0.7152f * p.y + 0.0722f * p.z + 0.5f), 0, 255);
}

// A straight-alpha pixel premultiplied, as floats from 0 to 1.
float4 premul_pixel(uchar4 p) {
  return premultiply(to_rgba(p));
}

// Reads a pixel, clamping coordinates to the image (extends the border).
uchar4 pixel_at(__global const uchar4 *img, int x, int y, int width, int height) {
  return img[clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)];
}

float3 rgb_at(__global const uchar4 *img, int x, int y, int width, int height) {
  return to_rgb(pixel_at(img, x, y, width, height));
}

float3 hsv_to_rgb(float h, float s, float v) {
  float3 k = fmod((float3)(5.0f, 3.0f, 1.0f) + h * 6.0f, 6.0f);
  return v - v * s * clamp(min(k, 4.0f - k), 0.0f, 1.0f);
}

// Replaces the luma of a colour, keeping its chroma (via Y'CbCr, BT.709).
float3 with_luma(float3 c, float new_y) {
  float y = luma(c);
  float cb = (c.z - y) / 1.8556f;
  float cr = (c.x - y) / 1.5748f;
  float r = new_y + 1.5748f * cr;
  float b = new_y + 1.8556f * cb;
  float g = (new_y - 0.2126f * r - 0.0722f * b) / 0.7152f;
  return (float3)(r, g, b);
}

// A cheap, well-mixed integer hash for deterministic pseudo-randomness.
uint hash3(uint x, uint y, uint seed) {
  uint h = x * 374761393u + y * 668265263u + seed * 2246822519u;
  h = (h ^ (h >> 13)) * 1274126177u;
  return h ^ (h >> 16);
}
