// Layer blending, for stacking filters: each filter in a stack can be laid
// over the image it was applied to with a blend mode and a strength. The
// formulas are the W3C Compositing and Blending ones (as in CSS
// mix-blend-mode and most photo editors); server/lib/stack.js numbers the modes.

#define BLEND_NORMAL 0
#define BLEND_MULTIPLY 1
#define BLEND_SCREEN 2
#define BLEND_OVERLAY 3
#define BLEND_SOFT_LIGHT 4
#define BLEND_DARKEN 5
#define BLEND_LIGHTEN 6
#define BLEND_DIFFERENCE 7
#define BLEND_COLOR 8
#define BLEND_LUMINOSITY 9

// The non-separable modes use the spec's luminosity weights rather than
// Rec. 709 luma, so results match browsers.
float blend_lum(float3 c) {
  return dot(c, (float3)(0.3f, 0.59f, 0.11f));
}

// Brings a colour back into 0-1 while keeping its luminosity.
float3 blend_clip(float3 c) {
  const float l = blend_lum(c);
  const float n = min(c.x, min(c.y, c.z));
  const float x = max(c.x, max(c.y, c.z));
  if (n < 0.0f) c = l + (c - l) * l / (l - n);
  if (x > 1.0f) c = l + (c - l) * (1.0f - l) / (x - l);
  return c;
}

float3 blend_set_lum(float3 c, float l) {
  return blend_clip(c + (l - blend_lum(c)));
}

float3 soft_light(float3 b, float3 t) {
  const float3 d = select(sqrt(b), ((16.0f * b - 12.0f) * b + 4.0f) * b, isless(b, (float3)(0.25f)));
  return select(b + (2.0f * t - 1.0f) * (d - b), b - (1.0f - 2.0f * t) * b * (1.0f - b),
                islessequal(t, (float3)(0.5f)));
}

float3 blend_rgb(float3 b, float3 t, int mode) {
  switch (mode) {
    case BLEND_MULTIPLY: return b * t;
    case BLEND_SCREEN: return b + t - b * t;
    // Overlay is hard light with the layers swapped: it keys off the base.
    case BLEND_OVERLAY:
      return select(1.0f - 2.0f * (1.0f - b) * (1.0f - t), 2.0f * b * t, isless(b, (float3)(0.5f)));
    case BLEND_SOFT_LIGHT: return soft_light(b, t);
    case BLEND_DARKEN: return min(b, t);
    case BLEND_LIGHTEN: return max(b, t);
    case BLEND_DIFFERENCE: return fabs(b - t);
    // Colour: the layer's hue and saturation, the base's brightness.
    case BLEND_COLOR: return blend_set_lum(t, blend_lum(b));
    // Luminosity: the layer's brightness, the base's colour.
    case BLEND_LUMINOSITY: return blend_set_lum(b, blend_lum(t));
    default: return t;
  }
}

// src is the filtered image (the layer), base the image the filter was applied
// to; both have straight alpha. Where the base is transparent the layer keeps
// its own colour, as in the spec's general formula
//   Cs' = (1 - ab) * Cs + ab * B(Cb, Cs),
// and amount (0-1) fades from the base to that blended layer, premultiplied,
// so a layer over a transparent base keeps its colour and gets amount of its
// alpha: at 50%, opaque red over nothing is red at alpha 0.5. When the layer
// is opaque this is exactly source-over compositing with opacity amount; when
// it isn't (a filter keeps its input's alpha), the base doesn't show through
// the layer as well, which would make a semi-transparent image more opaque
// with every layer.
__kernel void blend_layers(__global const uchar4 *src,
                           __global uchar4 *dst,
                           const int width,
                           const int height,
                           __global const uchar4 *base,
                           const int mode,
                           const float amount)
{
  GUARD;
  const float4 t = to_rgba(src[i]);
  const float4 b = to_rgba(base[i]);
  const float3 blended = mix(t.xyz, blend_rgb(b.xyz, t.xyz, mode), b.w);
  const float4 layer = premultiply((float4)(blended, t.w));
  dst[i] = from_rgba(unpremultiply(mix(premultiply(b), layer, amount)));
}
