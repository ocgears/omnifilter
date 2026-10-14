// Kernels the browser needs that the server doesn't have an OpenCL version
// of: the server resizes with sharp.
import { KernelSpec } from '../kernel';

export const BROWSER_ONLY: Record<string, KernelSpec> = {
  // Resizes src (sw x sh) to width x height, premultiplied: bilinear when
  // enlarging, averaging each output pixel's footprint when shrinking.
  resize: {
    args: 'src:in dst:out width:i32 height:i32 sw:i32 sh:i32',
    body: `
  let scale = vec2f(f32(sw) / f32(width), f32(sh) / f32(height));
  let centre = (vec2f(f32(x), f32(y)) + 0.5) * scale;
  if (scale.x <= 1.0 && scale.y <= 1.0) {
    dst[i] = from_rgba(sample_rgba_src(centre, sw, sh));
    return;
  }
  let lo = vec2i(floor(vec2f(f32(x), f32(y)) * scale));
  let hi = max(vec2i(ceil((vec2f(f32(x), f32(y)) + 1.0) * scale)), lo + 1);
  var sum = vec4f(0.0);
  for (var sy = lo.y; sy < hi.y; sy++) {
    for (var sx = lo.x; sx < hi.x; sx++) { sum += premul_pixel(at_src(sx, sy, sw, sh)); }
  }
  dst[i] = from_rgba(unpremultiply(sum / f32((hi.x - lo.x) * (hi.y - lo.y))));`,
  },
};
