'use strict';

// WGSL versions of the OpenCL kernels in native/kernels, so the same plans
// (server/lib/filters) run with WebGPU: on the viewer's GPU in the browser
// (the live preview, client/src/gpu) and on the server's (OMNIFILTER_BACKEND=
// webgpu, see backend.js).
//
// Each kernel is declared once with its argument list, in the same order as
// the OpenCL kernel's, and the body of its main function. From the list this
// generates the bindings, a uniform struct for the scalar arguments, `let`s
// that give the scalars their OpenCL names, and the GUARD macros, so bodies
// read much like the OpenCL originals.
//
// Argument kinds (name:kind):
//   in, out      RGBA8 pixels (OpenCL uchar4 *), read-only or read-write, as
//                array<u32>; see px() and pack() in common.js
//   img          RGBA8 pixels read as an image (OpenCL image2d_t): the same
//                buffer, with nearest and bilinear helpers (see common.js)
//   imgf4        an rgba32f image: array<vec4f>
//   f32s, f32out float buffers;  i32s, i32out int buffers;  u32s uint buffers
//   i32atomic, u32atomic   int / uint buffers updated with atomics
//   f4s, f4out   float4 buffers;  i2s  int2 buffers (array<vec2i>)
//   bytes        a byte array (uchar *), read with byte_NAME(i)
//   i32, f32     scalars
// A `data` argument in a plan binds as a read-only buffer of whichever kind
// the kernel declares there (f32s, bytes...).

// A kernel is declared as { args, body, guard?, workgroup?, barriers?,
// helpers? }: args is the argument list as 'name:kind ...'; body the main
// function's body; helpers module-scope WGSL (helper functions, constants,
// workgroup arrays). guard says how the kernel finds its pixel:
//   '2d'   (default) x, y and i from the global id, skipping the ones
//          outside width x height
//   'band' the same, offset by row0 (the last argument), so a big image can
//          run in bands of rows
//   'none' the body uses gid (and lid, wid for work-group kernels) itself;
//          work-items past the plan's global size return first unless the
//          kernel uses barriers (`barriers: true`), whose global sizes are
//          whole work-groups
// Types for TypeScript are in kernel.d.ts.

const SCALAR = ['i32', 'f32'];

function storageType(kind) {
  switch (kind) {
    case 'in':
    case 'img':
    case 'u32s':
    case 'bytes':
      return 'var<storage, read> NAME: array<u32>';
    case 'out':
      return 'var<storage, read_write> NAME: array<u32>';
    case 'imgf4':
    case 'f4s':
      return 'var<storage, read> NAME: array<vec4f>';
    case 'f4out':
      return 'var<storage, read_write> NAME: array<vec4f>';
    case 'f32s':
      return 'var<storage, read> NAME: array<f32>';
    case 'f32out':
      return 'var<storage, read_write> NAME: array<f32>';
    case 'i32s':
      return 'var<storage, read> NAME: array<i32>';
    case 'i32out':
      return 'var<storage, read_write> NAME: array<i32>';
    case 'i32atomic':
      return 'var<storage, read_write> NAME: array<atomic<i32>>';
    case 'u32atomic':
      return 'var<storage, read_write> NAME: array<atomic<u32>>';
    case 'i2s':
      return 'var<storage, read> NAME: array<vec2i>';
    default:
      throw new Error('not a buffer kind: ' + kind);
  }
}

function isWritable(kind) {
  return ['out', 'f4out', 'f32out', 'i32out', 'i32atomic', 'u32atomic'].includes(kind);
}

// Helpers for reading a pixel buffer as an image, made for each one by name.
function imageHelpers(name) {
  return `
fn at_${name}(x: i32, y: i32, w: i32, h: i32) -> u32 {
  return ${name}[clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)];
}
fn rgba_at_${name}(x: i32, y: i32, w: i32, h: i32) -> vec4f {
  return px(at_${name}(x, y, w, h));
}
fn rgb_at_${name}(x: i32, y: i32, w: i32, h: i32) -> vec3f {
  return px(at_${name}(x, y, w, h)).xyz;
}
// read_imagef with the NEAREST sampler: p in pixels, centres at +0.5.
fn nearest_${name}(p: vec2f, w: i32, h: i32) -> vec4f {
  return rgba_at_${name}(i32(floor(p.x)), i32(floor(p.y)), w, h);
}
// sample_premul in common.cl: bilinear, premultiplied.
fn sample_premul_${name}(p: vec2f, w: i32, h: i32) -> vec4f {
  let q = p - 0.5;
  let f = floor(q);
  let t = q - f;
  let x0 = i32(f.x);
  let y0 = i32(f.y);
  let a = premultiply(rgba_at_${name}(x0, y0, w, h));
  let b = premultiply(rgba_at_${name}(x0 + 1, y0, w, h));
  let d = premultiply(rgba_at_${name}(x0, y0 + 1, w, h));
  let e = premultiply(rgba_at_${name}(x0 + 1, y0 + 1, w, h));
  return mix(mix(a, b, t.x), mix(d, e, t.x), t.y);
}
fn sample_rgba_${name}(p: vec2f, w: i32, h: i32) -> vec4f {
  return unpremultiply(sample_premul_${name}(p, w, h));
}
`;
}

// read_imagef with the LINEAR sampler on a float image: bilinear, straight.
function floatImageHelpers(name) {
  return `
fn f4_at_${name}(x: i32, y: i32, w: i32, h: i32) -> vec4f {
  return ${name}[clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)];
}
fn linear_${name}(p: vec2f, w: i32, h: i32) -> vec4f {
  let q = p - 0.5;
  let f = floor(q);
  let t = q - f;
  let x0 = i32(f.x);
  let y0 = i32(f.y);
  return mix(mix(f4_at_${name}(x0, y0, w, h), f4_at_${name}(x0 + 1, y0, w, h), t.x),
             mix(f4_at_${name}(x0, y0 + 1, w, h), f4_at_${name}(x0 + 1, y0 + 1, w, h), t.x), t.y);
}
`;
}

function byteHelpers(name) {
  return `
fn byte_${name}(i: i32) -> u32 {
  return (${name}[i >> 2u] >> (u32(i & 3) * 8u)) & 255u;
}
`;
}

function parseArgs(spec) {
  return spec
    .trim()
    .split(/\s+/)
    .map((part) => {
      const [name, kind] = part.split(':');
      return { name, kind };
    });
}

function makeKernel(name, spec, common) {
  const args = parseArgs(spec.args);
  const bindings = args.filter((a) => !SCALAR.includes(a.kind));
  const scalars = args.filter((a) => SCALAR.includes(a.kind));
  const guard = spec.guard ?? '2d';
  const wg = spec.workgroup ?? (guard === 'none' ? [64] : [8, 8]);
  const workgroup = [wg[0], wg[1] ?? 1, wg[2] ?? 1];

  const decls = bindings.map(
    (a, i) => `@group(0) @binding(${i}) ${storageType(a.kind).replace('NAME', a.name)};`
  );
  // The plan's global size comes last, for the 'none' guard.
  const fields = scalars.map((a) => `  ${a.name}_: ${a.kind},`).concat(['  global_: vec2u,']);
  const helpers = bindings
    .map((a) => {
      if (a.kind === 'in' || a.kind === 'img' || a.kind === 'out') return imageHelpers(a.name);
      if (a.kind === 'imgf4') return floatImageHelpers(a.name);
      if (a.kind === 'bytes') return byteHelpers(a.name);
      return '';
    })
    .join('');

  const lets = scalars.map((a) => `  let ${a.name} = args.${a.name}_;`).join('\n');
  let prologue = '';
  if (guard === '2d' || guard === 'band') {
    const row0 = guard === 'band' ? ' + row0' : '';
    prologue = `
  let x = i32(gid.x);
  let y = i32(gid.y)${row0};
  if (x >= width || y >= height) { return; }
  let i = y * width + x;`;
  } else if (!spec.barriers) {
    prologue = `
  if (gid.x >= args.global_.x || gid.y >= args.global_.y) { return; }`;
  }

  const source = `${common}
${decls.join('\n')}
struct Args {
${fields.join('\n')}
}
@group(0) @binding(${bindings.length}) var<uniform> args: Args;
${helpers}
${spec.helpers ?? ''}
@compute @workgroup_size(${workgroup.join(', ')})
fn main(@builtin(global_invocation_id) gid: vec3u,
        @builtin(local_invocation_id) lid: vec3u,
        @builtin(workgroup_id) wid: vec3u) {
${lets}${prologue}
${spec.body}
}
`;
  return { name, args, bindings, scalars, workgroup, source };
}

module.exports = { isWritable, parseArgs, makeKernel };
