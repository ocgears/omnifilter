// Geometric distortions. Each kernel works out, for its output pixel, where
// in the source to look, then reads the source as an image (texture), which
// interpolates between pixels and clamps at the edges.
// Positions are in pixels with pixel centres at +0.5; (cx, cy) is the effect's
// centre as a fraction of the image size. Sampling is premultiplied (see
// sample_premul in common.cl), so transparent pixels' hidden colours don't
// bleed into their neighbours.

float4 sample_at(read_only image2d_t src, float2 p) {
  return sample_rgba(src, p);
}

// Twists the image around the centre, most strongly in the middle.
__kernel void swirl(read_only image2d_t src,
                    __global uchar4 *dst,
                    const int width,
                    const int height,
                    const float cx,
                    const float cy,
                    const float radius,
                    const float angle)
{
  GUARD;
  const float2 c = (float2)(cx * width, cy * height);
  const float2 d = (float2)(x + 0.5f, y + 0.5f) - c;
  const float dist = length(d);
  float2 p = c + d;
  if (dist < radius) {
    const float t = 1.0f - dist / radius;
    const float theta = angle * t * t;
    const float cs = cos(theta);
    const float sn = sin(theta);
    p = c + (float2)(cs * d.x - sn * d.y, sn * d.x + cs * d.y);
  }
  dst[i] = from_rgba(sample_at(src, p));
}

// Positive amounts magnify the centre (bulge); negative ones shrink it (pinch).
__kernel void pinch_bulge(read_only image2d_t src,
                          __global uchar4 *dst,
                          const int width,
                          const int height,
                          const float cx,
                          const float cy,
                          const float radius,
                          const float amount)
{
  GUARD;
  const float2 c = (float2)(cx * width, cy * height);
  const float2 d = (float2)(x + 0.5f, y + 0.5f) - c;
  const float dist = length(d);
  float2 p = c + d;
  if (dist < radius && dist > 0.0f) {
    const float rn = dist / radius;
    p = c + d * (pow(rn, 1.0f + amount) / rn);
  }
  dst[i] = from_rgba(sample_at(src, p));
}

// Full-frame fisheye: maps each pixel's distance from the centre through a
// tangent, which magnifies the middle and squeezes the edges.
__kernel void fisheye(read_only image2d_t src,
                      __global uchar4 *dst,
                      const int width,
                      const int height,
                      const float fov)
{
  GUARD;
  const float2 c = (float2)(width * 0.5f, height * 0.5f);
  const float2 d = (float2)(x + 0.5f, y + 0.5f) - c;
  const float max_r = length(c);
  const float rn = length(d) / max_r;
  float2 p = c + d;
  if (rn > 0.0f) {
    const float src_rn = tan(rn * fov * 0.5f) / tan(fov * 0.5f);
    p = c + d * (src_rn / rn);
  }
  dst[i] = from_rgba(sample_at(src, p));
}

// mode 0: rings spreading from the centre, like a drop in water.
// mode 1: horizontal and vertical waves.
__kernel void ripple(read_only image2d_t src,
                     __global uchar4 *dst,
                     const int width,
                     const int height,
                     const float amplitude,
                     const float wavelength,
                     const int mode)
{
  GUARD;
  const float2 q = (float2)(x + 0.5f, y + 0.5f);
  float2 p;
  if (mode == 0) {
    const float2 c = (float2)(width * 0.5f, height * 0.5f);
    const float2 d = q - c;
    const float dist = length(d);
    const float offset = amplitude * sin(2.0f * PI * dist / wavelength);
    p = dist > 0.0f ? q + d / dist * offset : q;
  } else {
    p = q + amplitude * (float2)(sin(2.0f * PI * q.y / wavelength), sin(2.0f * PI * q.x / wavelength));
  }
  dst[i] = from_rgba(sample_at(src, p));
}

// Radial lens distortion: positive amounts give barrel distortion (edges
// squeezed), negative pincushion. Scaled so the corners stay in frame.
__kernel void lens_distortion(read_only image2d_t src,
                              __global uchar4 *dst,
                              const int width,
                              const int height,
                              const float amount)
{
  GUARD;
  const float2 c = (float2)(width * 0.5f, height * 0.5f);
  const float2 d = (float2)(x + 0.5f, y + 0.5f) - c;
  const float r2 = dot(d, d) / dot(c, c);
  const float factor = (1.0f + amount * r2) / (1.0f + max(amount, 0.0f));
  dst[i] = from_rgba(sample_at(src, c + d * factor));
}

// Splits the colour channels apart towards the edges, like a cheap lens.
__kernel void chromatic_aberration(read_only image2d_t src,
                                   __global uchar4 *dst,
                                   const int width,
                                   const int height,
                                   const float amount)
{
  GUARD;
  const float2 c = (float2)(width * 0.5f, height * 0.5f);
  const float2 d = (float2)(x + 0.5f, y + 0.5f) - c;
  const float4 g = sample_at(src, c + d);
  const float r = sample_at(src, c + d * (1.0f + amount)).x;
  const float b = sample_at(src, c + d * (1.0f - amount)).z;
  dst[i] = from_rgba((float4)(r, g.y, b, g.w));
}

// Mirrors the image left to right (flip_x) and/or top to bottom (flip_y).
// mode 0 flips the whole image; 1 keeps the left (top) half and reflects it
// onto the other; 2 does that with the right (bottom) half. Pixels are copied
// as they are, with no resampling.
__kernel void mirror(__global const uchar4 *src,
                     __global uchar4 *dst,
                     const int width,
                     const int height,
                     const int flip_x,
                     const int flip_y,
                     const int mode)
{
  GUARD;
  int2 s = (int2)(x, y);
  const int2 r = (int2)(width - 1 - x, height - 1 - y);
  const int2 m = mode == 1 ? min(s, r) : (mode == 2 ? max(s, r) : r);
  if (flip_x) s.x = m.x;
  if (flip_y) s.y = m.y;
  dst[i] = src[s.y * width + s.x];
}
