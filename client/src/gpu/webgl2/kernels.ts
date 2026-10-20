// The filter kernels for WebGL2, made from the same WGSL the WebGPU engine
// runs (server/lib/webgpu/kernels), so there's one copy of each.
//
// WebGL2 has no compute shaders: a kernel runs as a fragment shader that
// draws its output buffer, each fragment working out the elements of the
// buffer at its texel. That works for every kernel that writes only its own
// element (out[i] for pixel i: "gather" kernels, all but a few). The rest
// (histograms, prefix sums, scattering seeds) run on the CPU: cpu-kernels.ts.
//
// Buffers are RGBA32UI textures holding the same bytes as WebGPU's buffers,
// four 32-bit words per texel, in rows of a fixed number of texels; so a
// buffer can be read as pixels, floats or ints exactly as the WGSL does.
import { COMMON } from '../../../../server/lib/webgpu/common';
import {
  KernelArg,
  KernelSpec,
  byteHelpers,
  floatImageHelpers,
  imageHelpers,
  parseArgs,
} from '../../../../server/lib/webgpu/kernel';
import KERNELS from '../../../../server/lib/webgpu/kernels';
import { CPU_KERNELS } from './cpu-kernels';
import { BufferRead, GLSL_PRELUDE, GlslOptions, glslName, wgslToGlsl } from './wgsl';

const ALL = KERNELS as Record<string, KernelSpec>;

// Kernels with no guard that still write only their own element: the
// element's index from the work-item's id is gid.y * stride + gid.x.
const STRIDED: Record<string, { stride: string; index: string }> = {
  downsample_box: { stride: 'small_width', index: 'sy * small_width + sx' },
  block_average: { stride: 'blocks_x', index: 'by * blocks_x + bx' },
  rd_init: { stride: 'gw', index: 'y * gw + x' },
  rd_step: { stride: 'gw', index: 'y * gw + x' },
};

const OUTPUTS = ['out', 'f32out', 'i32out', 'f4out'];
const SCALAR_KINDS = ['i32', 'f32'];

export interface GlKernel {
  name: string;
  args: KernelArg[];
  // The buffer arguments it reads, and the one it writes.
  inputs: KernelArg[];
  output: KernelArg;
  scalars: KernelArg[];
  // Elements of the output per texel: 4 words, or one vec4.
  perTexel: 1 | 4;
  guard: '2d' | 'band' | 'none';
  // For a 'none' kernel: the scalar argument that's its row stride.
  stride: string | null;
  workgroup: [number, number];
  // Whether it can return without writing an element it was run for.
  maySkip: boolean;
  source: string;
}

// Whether the kernel runs on the GPU here, on the CPU, or not at all.
export function glKernelKind(name: string): 'gpu' | 'cpu' | null {
  if (CPU_KERNELS[name]) return 'cpu';
  const spec = ALL[name];
  if (!spec) return null;
  if (spec.barriers || /atomic/.test(spec.args)) return null;
  if ((spec.guard ?? '2d') === 'none' && !STRIDED[name]) return null;
  const outputs = parseArgs(spec.args).filter((a) => OUTPUTS.includes(a.kind));
  return outputs.length === 1 ? 'gpu' : null;
}

function reader(arg: KernelArg): { read: BufferRead; glsl: string } {
  const n = arg.name;
  const sampler = 'uniform highp usampler2D _b_' + n + ';\n';
  const words =
    'uint _ld_' +
    n +
    '(int i) {\n' +
    '  int t = i >> 2;\n' +
    '  return texelFetch(_b_' +
    n +
    ', ivec2(t % _TW, t / _TW), 0)[i & 3];\n' +
    '}\n';
  switch (arg.kind) {
    case 'in':
    case 'img':
    case 'u32s':
    case 'bytes':
      return { read: { call: '_ld_' + n, type: { kind: 'u', n: 1 } }, glsl: sampler + words };
    case 'f32s':
      return {
        read: { call: '_ldf_' + n, type: { kind: 'f', n: 1 } },
        glsl:
          sampler +
          words +
          'float _ldf_' +
          n +
          '(int i) { return uintBitsToFloat(_ld_' +
          n +
          '(i)); }\n',
      };
    case 'i32s':
      return {
        read: { call: '_ldi_' + n, type: { kind: 'i', n: 1 } },
        glsl: sampler + words + 'int _ldi_' + n + '(int i) { return int(_ld_' + n + '(i)); }\n',
      };
    case 'f4s':
    case 'imgf4':
      return {
        read: { call: '_ld4_' + n, type: { kind: 'f', n: 4 } },
        glsl:
          sampler +
          'vec4 _ld4_' +
          n +
          '(int i) {\n' +
          '  return uintBitsToFloat(texelFetch(_b_' +
          n +
          ', ivec2(i % _TW, i / _TW), 0));\n' +
          '}\n',
      };
    case 'i2s':
      return {
        read: { call: '_ld2_' + n, type: { kind: 'i', n: 2 } },
        glsl:
          sampler +
          'ivec2 _ld2_' +
          n +
          '(int i) {\n' +
          '  int t = i >> 1;\n' +
          '  uvec4 v = texelFetch(_b_' +
          n +
          ', ivec2(t % _TW, t / _TW), 0);\n' +
          '  return (i & 1) == 0 ? ivec2(v.xy) : ivec2(v.zw);\n' +
          '}\n',
      };
    default:
      throw new Error('No WebGL2 reader for ' + arg.kind);
  }
}

// The WGSL helpers kernel.js makes for each argument it reads.
function wgslHelpers(arg: KernelArg): string {
  if (arg.kind === 'in' || arg.kind === 'img') return imageHelpers(arg.name);
  if (arg.kind === 'imgf4') return floatImageHelpers(arg.name);
  if (arg.kind === 'bytes') return byteHelpers(arg.name);
  return '';
}

const OUTPUT_WRITE: Record<string, { want: { kind: 'f' | 'i' | 'u'; n: number }; assign: string }> =
  {
    out: { want: { kind: 'u', n: 1 }, assign: '_res = $; _wrote = true' },
    i32out: { want: { kind: 'i', n: 1 }, assign: '_res = uint($); _wrote = true' },
    f32out: { want: { kind: 'f', n: 1 }, assign: '_res = floatBitsToUint($); _wrote = true' },
    f4out: { want: { kind: 'f', n: 4 }, assign: '_res4 = floatBitsToUint($); _wrote = true' },
  };

// The fragment shader for a GPU kernel, with buffers in rows of rowTexels.
export function glKernel(name: string, rowTexels: number): GlKernel {
  const spec = ALL[name];
  if (!spec || glKernelKind(name) !== 'gpu')
    throw new Error('No WebGL2 version of the ' + name + ' kernel');
  const args = parseArgs(spec.args);
  const output = args.find((a) => OUTPUTS.includes(a.kind))!;
  const inputs = args.filter((a) => !SCALAR_KINDS.includes(a.kind) && a !== output);
  const scalars = args.filter((a) => SCALAR_KINDS.includes(a.kind));
  const guard = spec.guard ?? '2d';
  const wg = spec.workgroup ?? (guard === 'none' ? [64] : [8, 8]);
  const strided = STRIDED[name];

  // The kernel as one WGSL function of its work-item id. The work-items
  // the shader runs are already inside the image, so there's no bounds
  // check (see main below).
  let prologue = '';
  if (guard !== 'none') {
    prologue =
      '  let x = i32(gid.x);\n' +
      '  let y = i32(gid.y)' +
      (guard === 'band' ? ' + row0' : '') +
      ';\n' +
      '  let i = y * width + x;\n';
  }
  const wgsl =
    COMMON +
    inputs.map(wgslHelpers).join('') +
    (spec.helpers ?? '') +
    '\nfn _kernel(gid: vec3u) {\n' +
    prologue +
    spec.body +
    '\n}\n';

  const buffers: GlslOptions['buffers'] = {};
  let readers = '';
  for (const arg of inputs) {
    const r = reader(arg);
    buffers[arg.name] = r.read;
    readers += r.glsl;
  }
  const globals: GlslOptions['globals'] = {};
  for (const s of scalars) globals[s.name] = { kind: s.kind === 'i32' ? 'i' : 'f', n: 1 };
  const write = OUTPUT_WRITE[output.kind];
  const translated = wgslToGlsl(wgsl, {
    buffers,
    globals,
    output: { name: output.name, index: strided ? strided.index : 'i', ...write },
    entry: '_kernel',
  });

  const perTexel = output.kind === 'f4out' ? 1 : 4;
  const uniforms = scalars
    .map((s) => 'uniform ' + (s.kind === 'i32' ? 'int ' : 'float ') + glslName(s.name) + ';\n')
    .join('');
  const store = perTexel === 4 ? 'r[k] = _res;' : 'r = _res4;';
  const source =
    '#version 300 es\n' +
    'precision highp float;\nprecision highp int;\nprecision highp usampler2D;\n' +
    'const int _TW = ' +
    rowTexels +
    ';\n' +
    uniforms +
    // The elements to write, [_lo, _hi); the work-item id of element o is
    // (o % _stride, o / _stride - _row0), run if it's below (_dx, _dy).
    'uniform int _lo;\nuniform int _hi;\nuniform int _stride;\nuniform int _row0;\n' +
    'uniform uint _dx;\nuniform uint _dy;\n' +
    // A copy of the output, for elements of a texel the kernel doesn't write.
    'uniform int _keep;\nuniform highp usampler2D _old;\n' +
    'layout(location = 0) out uvec4 _frag;\n' +
    'uint _res;\nuvec4 _res4;\nbool _wrote;\n' +
    GLSL_PRELUDE +
    readers +
    translated.code +
    '\nvoid main() {\n' +
    '  int t = int(gl_FragCoord.y) * _TW + int(gl_FragCoord.x);\n' +
    '  uvec4 r = _keep != 0 ? texelFetch(_old, ivec2(gl_FragCoord.xy), 0) : uvec4(0u);\n' +
    '  bool any_ = false;\n' +
    '  for (int k = 0; k < ' +
    perTexel +
    '; k++) {\n' +
    '    int o = t * ' +
    perTexel +
    ' + k;\n' +
    '    if (o < _lo || o >= _hi) continue;\n' +
    '    uvec3 gid = uvec3(uint(o % _stride), uint(o / _stride - _row0), 0u);\n' +
    '    if (gid.x >= _dx || gid.y >= _dy) continue;\n' +
    '    _wrote = false;\n' +
    '    _kernel(gid);\n' +
    '    if (_wrote) { ' +
    store +
    ' any_ = true; }\n' +
    '  }\n' +
    '  if (!any_ && _keep == 0) discard;\n' +
    '  _frag = r;\n' +
    '}\n';

  return {
    name,
    args,
    inputs,
    output,
    scalars,
    perTexel,
    guard,
    stride: strided ? strided.stride : null,
    workgroup: [wg[0], wg[1] ?? 1],
    maySkip: translated.maySkip,
    source,
  };
}

// Every kernel with a WGSL version, and how WebGL2 runs it.
export function glKernelNames(): string[] {
  return Object.keys(ALL);
}
