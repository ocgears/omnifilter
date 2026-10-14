// The server's own filter definitions (server/lib/filters), bundled into the
// client so the preview builds exactly the plans the server runs: the same
// kernels, weights and sizes. Every module that's plain JavaScript is here;
// the looks from .cube files in server/luts (cube_looks.js) and the neural
// styles (ONNX Runtime) are left to the server.
import adjust from '../../../server/lib/filters/adjust.js';
import blur from '../../../server/lib/filters/blur.js';
import colour from '../../../server/lib/filters/colour.js';
import distort from '../../../server/lib/filters/distort.js';
import edges from '../../../server/lib/filters/edges.js';
import generative from '../../../server/lib/filters/generative.js';
import looks from '../../../server/lib/filters/looks.js';
import retro from '../../../server/lib/filters/retro.js';
import stylize from '../../../server/lib/filters/stylize.js';
import { GpuEngine, NativePlan } from './engine';

export type ParamValue = string | number;

export interface ParamDecl {
  name: string;
  type: 'range' | 'select';
  min?: number;
  max?: number;
  step?: number;
  default: ParamValue;
  options?: { value: string }[];
}

export interface FilterDef {
  name: string;
  params?: ParamDecl[];
  plan?: (w: number, h: number, p: Record<string, ParamValue>) => { native(): NativePlan };
  run?: unknown;
  workingSize?: (p: Record<string, ParamValue>) => number;
}

const DEFS = [
  ...blur,
  ...edges,
  ...colour,
  ...looks,
  ...stylize,
  ...retro,
  ...distort,
  ...adjust,
  ...generative,
] as unknown as FilterDef[];

const BY_NAME = new Map(DEFS.map((d) => [d.name, d]));

export function filterDef(name: string): FilterDef | undefined {
  return BY_NAME.get(name);
}

// normalizeParams and roundWholeParams in server/lib: defaults for anything
// missing, values clamped to their range, whole-number settings rounded.
export function normalizeParams(def: FilterDef, raw: unknown): Record<string, ParamValue> {
  const given =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const out: Record<string, ParamValue> = {};
  for (const p of def.params ?? []) {
    const value = Object.prototype.hasOwnProperty.call(given, p.name) ? given[p.name] : undefined;
    if (p.type === 'select') {
      out[p.name] = (p.options ?? []).some((o) => o.value === value)
        ? (value as string)
        : p.default;
      continue;
    }
    const n =
      typeof value === 'number' || (typeof value === 'string' && value !== '')
        ? Number(value)
        : NaN;
    let v = Number.isFinite(n) ? Math.min(p.max!, Math.max(p.min!, n)) : (p.default as number);
    if (Number.isInteger(p.step) && Number.isInteger(p.min)) {
      v = Math.min(p.max!, Math.max(p.min!, Math.round(v)));
    }
    out[p.name] = v;
  }
  return out;
}

// The size the server runs a filter at for a full-size photo (sizedPlan in
// server/lib/gpu_filters.js): filters with a working size run on a copy
// whose longer side is at most that.
export function workingSize(
  def: FilterDef,
  params: Record<string, ParamValue>,
  fullWidth: number,
  fullHeight: number,
): { width: number; height: number } {
  const target = def.workingSize ? def.workingSize(params) : Infinity;
  const scale = Math.min(1, target / Math.max(fullWidth, fullHeight));
  return {
    width: Math.max(1, Math.round(fullWidth * scale)),
    height: Math.max(1, Math.round(fullHeight * scale)),
  };
}

// The plan for one filter at a size, or why there isn't one in the browser.
export function buildPlan(
  name: string,
  width: number,
  height: number,
  raw: unknown,
): { plan: NativePlan } | { reason: string } {
  const def = filterDef(name);
  if (!def) return { reason: 'runs on the server only' };
  if (!def.plan) return { reason: 'runs on the server only' };
  const plan = def.plan(width, height, normalizeParams(def, raw)).native();
  const missing = GpuEngine.unsupported(plan);
  return missing ? { reason: 'needs ' + missing } : { plan };
}

// Whether a filter can be previewed in the browser at all, checked with its
// default settings on a small image.
export function previewable(name: string): boolean {
  return 'plan' in buildPlan(name, 16, 16, {});
}

export function allFilterNames(): string[] {
  return DEFS.map((d) => d.name);
}
