import { GpuEngine, PlanArg } from './engine';
import {
  allFilterNames,
  buildPlan,
  filterDef,
  normalizeParams,
  previewable,
  workingSize,
} from './filters';
import { COMMON } from './common';
import { makeKernel, parseArgs } from './kernel';
import { KERNELS } from './kernels';

// Every combination of a filter's choices, with the other settings at their
// defaults: different choices can use different kernels.
function variants(name: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{}];
  for (const p of filterDef(name)?.params ?? []) {
    if (p.type !== 'select') continue;
    for (const o of p.options ?? []) out.push({ [p.name]: o.value });
  }
  return out;
}

describe('the shared filter definitions', () => {
  it('previews every filter except the neural styles', () => {
    const names = allFilterNames();
    expect(names.length).toBeGreaterThan(45);
    expect(names.filter((n) => !previewable(n))).toEqual([]);
    expect(filterDef('style_mosaic')).toBeUndefined();
    expect(previewable('style_mosaic')).toBe(false);
  });

  it("builds plans whose every pass matches a WebGPU kernel's arguments", () => {
    const scalar = (a: PlanArg) => 'int' in a || 'float' in a;
    for (const name of allFilterNames()) {
      for (const params of variants(name)) {
        const built = buildPlan(name, 37, 23, params);
        if (!('plan' in built)) throw new Error(name + ' ' + built.reason);
        for (const pass of built.plan.passes) {
          const args = parseArgs(KERNELS[pass.kernel].args);
          const where = name + ' ' + JSON.stringify(params) + ' ' + pass.kernel;
          expect(pass.args.length, where).toBe(args.length);
          pass.args.forEach((a, i) => {
            const isScalar = args[i].kind === 'i32' || args[i].kind === 'f32';
            expect(scalar(a), where + ' argument ' + args[i].name).toBe(isScalar);
          });
        }
      }
    }
  });

  it('normalizes settings the way the server does', () => {
    const blur = filterDef('blur')!;
    expect(normalizeParams(blur, {})).toEqual({ radius: 0.67 });
    expect(normalizeParams(blur, { radius: 99 })).toEqual({ radius: 5 });
    expect(normalizeParams(blur, { radius: '1.5' })).toEqual({ radius: 1.5 });
    expect(normalizeParams(blur, { radius: { evil: true } })).toEqual({ radius: 0.67 });
    const posterize = filterDef('posterize')!;
    expect(normalizeParams(posterize, { levels: 5.6 })).toEqual({ levels: 6 });
    const sobel = filterDef('sobel')!;
    expect(normalizeParams(sobel, { style: 'nonsense' })['style']).toBe('neon');
    expect(normalizeParams(sobel, { style: 'ink' })['style']).toBe('ink');
  });

  it("works out the server's working size for painterly filters", () => {
    const bilateral = filterDef('bilateral')!;
    const p = normalizeParams(bilateral, { detail: 2000 });
    expect(workingSize(bilateral, p, 4000, 3000)).toEqual({ width: 2000, height: 1500 });
    expect(workingSize(bilateral, p, 1000, 800)).toEqual({ width: 1000, height: 800 });
    expect(workingSize(filterDef('blur')!, {}, 4000, 3000)).toEqual({ width: 4000, height: 3000 });
  });

  it("says why a plan can't run in the browser", () => {
    expect(
      GpuEngine.unsupported({ buffers: [], passes: [{ kernel: 'nope', args: [] }], output: 'src' }),
    ).toBe('kernel nope');
    expect(buildPlan('style_candy', 8, 8, {})).toEqual({ reason: 'runs on the server only' });
  });
});

describe('the WGSL generator', () => {
  it('binds buffers in order, then one uniform of the scalars and the global size', () => {
    const k = makeKernel(
      'demo',
      { args: 'src:in dst:out width:i32 height:i32 w:f32s amount:f32', body: 'dst[i] = src[i];' },
      COMMON,
    );
    expect(k.bindings.map((b) => b.name)).toEqual(['src', 'dst', 'w']);
    expect(k.scalars.map((s) => s.name)).toEqual(['width', 'height', 'amount']);
    expect(k.workgroup).toEqual([8, 8, 1]);
    expect(k.source).toContain('@group(0) @binding(0) var<storage, read> src: array<u32>;');
    expect(k.source).toContain('@group(0) @binding(1) var<storage, read_write> dst: array<u32>;');
    expect(k.source).toContain('@group(0) @binding(2) var<storage, read> w: array<f32>;');
    expect(k.source).toContain('@group(0) @binding(3) var<uniform> args: Args;');
    expect(k.source).toMatch(/width_: i32,\s+height_: i32,\s+amount_: f32,\s+global_: vec2u,/);
    expect(k.source).toContain('if (x >= width || y >= height) { return; }');
  });

  it('makes a source for every kernel', () => {
    for (const [name, spec] of Object.entries(KERNELS)) {
      const k = makeKernel(name, spec, COMMON);
      expect(k.source, name).toContain('fn main(');
      expect(k.bindings.length, name).toBeGreaterThan(0);
    }
  });
});
