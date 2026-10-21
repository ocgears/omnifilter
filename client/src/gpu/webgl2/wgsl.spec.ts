import KERNELS from '../../../../server/lib/webgpu/kernels';
import { GlEngine } from './engine';
import { glKernel, glKernelKind, glKernelNames } from './kernels';
import { canonical, tokenize, wgslToGlsl } from './wgsl';

const scalarF = { kind: 'f' as const, n: 1 };
const scalarI = { kind: 'i' as const, n: 1 };

// The GLSL for one WGSL function, without its prototype.
function translate(src: string, globals = {}): string {
  return wgslToGlsl(src, { buffers: {}, globals }).code.split('\n').slice(1).join('\n');
}

describe('the WGSL to GLSL translation', () => {
  it('reads every kind of number WGSL has', () => {
    expect(tokenize('1 1u 2i 1.5 1e-3 0x1fu 0x1.fffffep+127f 3f .5').map((t) => t.v)).toEqual([
      '1',
      '1u',
      '2i',
      '1.5',
      '1e-3',
      '0x1fu',
      '0x1.fffffep+127f',
      '3f',
      '.5',
      '',
    ]);
  });

  it('writes each declaration with the type WGSL infers', () => {
    const glsl = translate(`
fn f(a: vec3f, n: i32) -> f32 {
  let b = a * 2.0;
  var k = n / 2;
  let u = u32(k) >> 1u;
  var s: array<vec4f, 2>;
  var o: vec3f;
  let same = a == b;
  return b.x + f32(u) + s[1].w + o.y + select(0.0, 1.0, all(same));
}`);
    expect(glsl).toContain('vec3 b = (a * 2.0);');
    expect(glsl).toContain('int k = (n / 2);');
    expect(glsl).toContain('uint u = (uint(k) >> 1u);');
    expect(glsl).toContain('vec4 s[2] = vec4[2](vec4(0.0), vec4(0.0));');
    expect(glsl).toContain('vec3 o = vec3(0.0);');
    expect(glsl).toContain('bvec3 same = equal(a, b);');
    expect(glsl).toContain('((all(same)) ? (1.0) : (0.0))');
  });

  it('gives untyped literals the type they meet', () => {
    const glsl = translate(`
var<private> T: array<f32, 3> = array<f32, 3>(0, 32, 8);
fn f(x: f32, n: u32) -> f32 {
  let a = x * 2;
  let b = n + 1;
  return a + f32(b) + T[1];
}`);
    expect(glsl).toContain('float T[3] = float[3](0.0, 32.0, 8.0);');
    expect(glsl).toContain('float a = (x * 2.0);');
    expect(glsl).toContain('uint b = (n + 1u);');
  });

  it("uses GLSL's names for WGSL's built-ins, and keeps WGSL's rounding", () => {
    const glsl = translate(`
fn f(v: vec3f, y: f32, x: f32) -> vec3f {
  return select(v, round(v), v < vec3f(0.5)) + atan2(y, x) + v % 2.0;
}`);
    expect(glsl).toContain('mix(v, roundEven(v), lessThan(v, vec3(0.5)))');
    expect(glsl).toContain('atan(y, x)');
    expect(glsl).toContain('(v - 2.0 * trunc(v / 2.0))');
  });

  it('renames names that are GLSL keywords', () => {
    const glsl = translate('fn f(sample: f32) -> f32 { var out = sample; return out; }');
    expect(glsl).toContain('float f(float sample_w)');
    expect(glsl).toContain('float out_w = sample_w;');
  });

  it('turns reading a buffer into a call, and writing the output into the result', () => {
    const { code, maySkip } = wgslToGlsl(
      `fn k(i: i32, w: i32) {
  if (w < 0) { return; }
  dst[i] = src[i] & 255u;
}`,
      {
        buffers: { src: { call: 'load_src', type: { kind: 'u', n: 1 } } },
        globals: {},
        output: { name: 'dst', index: 'i', want: { kind: 'u', n: 1 }, assign: 'res = $' },
        entry: 'k',
      },
    );
    expect(code).toContain('res = (load_src(i) & 255u);');
    expect(maySkip).toBe(true);
  });

  it('refuses kernels that write anything but their own element', () => {
    const opts = {
      buffers: {},
      globals: { width: scalarI },
      output: { name: 'dst', index: 'i', want: { kind: 'u' as const, n: 1 }, assign: 'res = $' },
    };
    expect(() => wgslToGlsl('fn k(i: i32) { dst[i + 1] = 0u; }', opts)).toThrow(/own element/);
    expect(() => wgslToGlsl('fn k(i: i32) -> u32 { return dst[i]; }', opts)).toThrow(
      /reads its output/,
    );
    expect(canonical('y * width + x')).toBe(canonical('y*width+x'));
  });

  it('translates every kernel that runs on the GPU, and runs the rest on the CPU', () => {
    const names = Object.keys(KERNELS);
    expect(glKernelNames()).toEqual(names);
    for (const name of names) {
      expect(glKernelKind(name), name).not.toBeNull();
      expect(GlEngine.hasKernel(name), name).toBe(true);
      if (glKernelKind(name) !== 'gpu') continue;
      const k = glKernel(name, 4096);
      expect(k.source, name).toContain('void _kernel(uvec3 gid) {');
      expect(k.source, name).not.toMatch(/\b(let|fn|vec[234][fiu]|f32|i32|u32)\b/);
    }
    expect(names.filter((n) => glKernelKind(n) === 'cpu').sort()).toEqual([
      'auto_levels_params',
      'cell_accumulate',
      'clahe_hist',
      'clahe_lut',
      'equalize_lut',
      'histogram',
      'jfa_plant',
    ]);
  });

  it('knows which kernels can leave some of their elements alone', () => {
    expect(glKernel('convolve', 4096).maySkip).toBe(false);
    expect(glKernel('median', 4096).maySkip).toBe(false);
    expect(glKernel('downsample_box', 4096).maySkip).toBe(true);
    expect(glKernel('rd_step', 4096).perTexel).toBe(1);
  });

  it('writes out short constant loops, so arrays are indexed by constants', () => {
    const glsl = translate(`
fn f() -> f32 {
  var a: array<f32, 3>;
  for (var n = 0; n < 3; n++) {
    if (n == 1) { continue; }
    a[n] += 1.0;
  }
  for (var m = 0; m < 3; m++) {
    if (a[m] > 0.0) { break; }
  }
  return a[2];
}`);
    expect(glsl).toContain('const int n = 2;');
    expect(glsl.match(/do \{/g)).toHaveLength(3);
    expect(glsl).toContain('a[n] += 1.0;');
    // A loop that breaks stays a loop.
    expect(glsl).toContain('for (int m = 0; (m < 3); m++)');
  });

  it('keeps scalars as uniforms', () => {
    expect(translate('fn f() -> f32 { return gamma * 2.0; }', { gamma: scalarF })).toContain(
      'return (gamma * 2.0);',
    );
  });
});
