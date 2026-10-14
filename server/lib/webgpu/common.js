'use strict';

// WGSL helpers shared by every kernel: native/kernels/common.cl's, with the
// same names where possible.
//
// Pixels are RGBA8 packed into a u32 (red in the low byte), the same bytes as
// an OpenCL uchar4. px() unpacks to floats from 0 to 1; pack() rounds back
// to bytes, half to even like OpenCL's convert_uchar4_sat_rte (WGSL's
// round() rounds half to even), so results match the server's byte for byte
// wherever the float maths does.
exports.COMMON = /* wgsl */ `
const PI = 3.14159265358979;
const MAXFLOAT = 0x1.fffffep+127f;

fn px(p: u32) -> vec4f {
  return unpack4x8unorm(p);
}

fn bytes4(p: u32) -> vec4u {
  return vec4u(p & 255u, (p >> 8u) & 255u, (p >> 16u) & 255u, p >> 24u);
}

fn pack_bytes(v: vec4u) -> u32 {
  return v.x | (v.y << 8u) | (v.z << 16u) | (v.w << 24u);
}

// convert_uchar4_sat_rte(c * 255).
fn pack(c: vec4f) -> u32 {
  return pack_bytes(vec4u(round(clamp(c * 255.0, vec4f(0.0), vec4f(255.0)))));
}

fn sat_u8(v: f32) -> u32 {
  return u32(round(clamp(v, 0.0, 255.0)));
}

fn alpha_of(p: u32) -> u32 {
  return p >> 24u;
}

fn to_rgb(p: u32) -> vec3f {
  return px(p).xyz;
}

fn to_rgba(p: u32) -> vec4f {
  return px(p);
}

// from_rgb(c, alpha): colour from floats, alpha as a byte.
fn from_rgb(c: vec3f, a: u32) -> u32 {
  let v = vec3u(round(clamp(c * 255.0, vec3f(0.0), vec3f(255.0))));
  return pack_bytes(vec4u(v, a));
}

fn from_rgba(c: vec4f) -> u32 {
  return pack(c);
}

fn premultiply(c: vec4f) -> vec4f {
  return vec4f(c.xyz * c.w, c.w);
}

fn unpremultiply(c: vec4f) -> vec4f {
  if (c.w > 0.0) {
    return vec4f(c.xyz / c.w, c.w);
  }
  return vec4f(0.0);
}

fn premul_pixel(p: u32) -> vec4f {
  return premultiply(px(p));
}

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn luma_bin(p: u32) -> i32 {
  let b = vec3f(bytes4(p).xyz);
  return clamp(i32(0.2126 * b.x + 0.7152 * b.y + 0.0722 * b.z + 0.5), 0, 255);
}

// OpenCL's fmod: the sign follows x (WGSL's % does the same for floats).
fn fmod3(x: vec3f, y: f32) -> vec3f {
  return x - y * trunc(x / y);
}

fn hsv_to_rgb(h: f32, s: f32, v: f32) -> vec3f {
  let k = fmod3(vec3f(5.0, 3.0, 1.0) + h * 6.0, 6.0);
  return v - v * s * clamp(min(k, 4.0 - k), vec3f(0.0), vec3f(1.0));
}

fn with_luma(c: vec3f, new_y: f32) -> vec3f {
  let y = luma(c);
  let cb = (c.z - y) / 1.8556;
  let cr = (c.x - y) / 1.5748;
  let r = new_y + 1.5748 * cr;
  let b = new_y + 1.8556 * cb;
  let g = (new_y - 0.2126 * r - 0.0722 * b) / 0.7152;
  return vec3f(r, g, b);
}

fn hash3(x: u32, y: u32, seed: u32) -> u32 {
  var h = x * 374761393u + y * 668265263u + seed * 2246822519u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return h ^ (h >> 16u);
}
`;
