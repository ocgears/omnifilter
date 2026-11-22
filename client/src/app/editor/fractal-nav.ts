// Interactive navigation helpers for the Fractal explorer filter: move (pan),
// zoom, reset view, and snap to edge (which recovers a rich fractal boundary
// when the viewer pans or zooms deep into uniform interior or exterior space).
import { ParamValues } from '../models';

export interface FractalPresetSpec {
  type: 0 | 1 | 2 | 3;
  centerX: number;
  centerY: number;
  baseZoom: number;
  cRe: number;
  cIm: number;
}

export const FRACTAL_PRESETS: Record<string, FractalPresetSpec> = {
  mandelbrot: { type: 0, centerX: -0.5, centerY: 0.0, baseZoom: 1.0, cRe: -0.7, cIm: 0.27015 },
  seahorse: {
    type: 0,
    centerX: -0.74364,
    centerY: 0.13183,
    baseZoom: 32.0,
    cRe: -0.74364,
    cIm: 0.13183,
  },
  elephant: {
    type: 0,
    centerX: 0.28172,
    centerY: 0.57711,
    baseZoom: 24.0,
    cRe: 0.28172,
    cIm: 0.57711,
  },
  julia_spiral: { type: 1, centerX: 0.0, centerY: 0.0, baseZoom: 1.0, cRe: -0.4, cIm: 0.6 },
  julia_rabbit: { type: 1, centerX: 0.0, centerY: 0.0, baseZoom: 1.0, cRe: -0.123, cIm: 0.745 },
  julia_dragon: { type: 1, centerX: 0.0, centerY: 0.0, baseZoom: 1.0, cRe: -0.8, cIm: 0.156 },
  julia_dendrite: { type: 1, centerX: 0.0, centerY: 0.0, baseZoom: 1.0, cRe: 0.0, cIm: 1.0 },
  julia_siegel: { type: 1, centerX: 0.0, centerY: 0.0, baseZoom: 1.0, cRe: -0.391, cIm: -0.587 },
  burning_ship: { type: 2, centerX: -0.45, centerY: -0.5, baseZoom: 0.9, cRe: -0.45, cIm: -0.5 },
  tricorn: { type: 3, centerX: -0.3, centerY: 0.0, baseZoom: 0.95, cRe: -0.3, cIm: 0.0 },
};

const PAN_MIN = -2;
const PAN_MAX = 2;
const ZOOM_MIN = -1;
const ZOOM_MAX = 14;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const roundPan = (v: number): number => Number(clamp(v, PAN_MIN, PAN_MAX).toFixed(4));
const roundZoom = (v: number): number => Number(clamp(v, ZOOM_MIN, ZOOM_MAX).toFixed(1));

export function presetFor(params: ParamValues): FractalPresetSpec {
  const key = String(params['preset'] ?? 'mandelbrot');
  return FRACTAL_PRESETS[key] ?? FRACTAL_PRESETS['mandelbrot'];
}

export function isFractalMoved(params: ParamValues): boolean {
  return (
    Number(params['pan_x'] ?? 0) !== 0 ||
    Number(params['pan_y'] ?? 0) !== 0 ||
    Number(params['zoom'] ?? 0) !== 0
  );
}

// Moves the fractal view by (dirX, dirY) in units of the current viewport,
// so a click pans by the same fraction of the screen at any zoom depth.
export function panFractal(params: ParamValues, dirX: number, dirY: number): ParamValues {
  const preset = presetFor(params);
  const zoom = Number(params['zoom'] ?? 0);
  const effectiveZoom = preset.baseZoom * Math.pow(2, zoom);
  const step = 0.35 / Math.max(effectiveZoom, 0.25);
  const panX = roundPan(Number(params['pan_x'] ?? 0) + dirX * step);
  const panY = roundPan(Number(params['pan_y'] ?? 0) + dirY * step);
  return { ...params, pan_x: panX, pan_y: panY };
}

export function zoomFractal(params: ParamValues, deltaZoom: number): ParamValues {
  const zoom = roundZoom(Number(params['zoom'] ?? 0) + deltaZoom);
  return { ...params, zoom };
}

export function resetFractalView(params: ParamValues): ParamValues {
  return { ...params, pan_x: 0, pan_y: 0, zoom: 0 };
}

// Evaluates escape iterations for a point (re, im) in the complex plane,
// matching the GPU fractal kernel in generative.cl / generative.js.
export function evaluateFractalPoint(
  re: number,
  im: number,
  preset: FractalPresetSpec,
  mode: string,
  maxIter: number,
): number {
  const effType = mode === 'seeded' ? 1 : preset.type;
  const cRe =
    mode === 'seeded' ? -0.52 + (preset.cRe + 0.4) * 0.08 : effType === 1 ? preset.cRe : re;
  const cIm =
    mode === 'seeded' ? 0.52 + (preset.cIm - 0.6) * 0.08 : effType === 1 ? preset.cIm : im;
  let zRe = effType === 1 ? re : 0.0;
  let zIm = effType === 1 ? im : 0.0;

  let iter = 0;
  while (iter < maxIter) {
    const zr2 = zRe * zRe;
    const zi2 = zIm * zIm;
    if (zr2 + zi2 > 4.0) break;
    let nextIm = 2.0 * zRe * zIm + cIm;
    if (effType === 2) nextIm = 2.0 * Math.abs(zRe * zIm) + cIm;
    else if (effType === 3) nextIm = -2.0 * zRe * zIm + cIm;
    zRe = zr2 - zi2 + cRe;
    zIm = nextIm;
    iter++;
  }
  return iter;
}

// Measures how rich the fractal boundary is inside a viewport centered at
// (cx, cy) with half-span `span`: highest when the view contains both
// interior (or deep) points and escaping filaments with high variance.
function edgeScoreAt(
  cx: number,
  cy: number,
  span: number,
  preset: FractalPresetSpec,
  mode: string,
  maxIter: number,
): number {
  const values: number[] = [];
  let interior = 0;
  let midBand = 0;
  let sum = 0;
  for (let gy = -2; gy <= 2; gy++) {
    for (let gx = -2; gx <= 2; gx++) {
      const it = evaluateFractalPoint(
        cx + gx * 0.5 * span,
        cy + gy * 0.5 * span,
        preset,
        mode,
        maxIter,
      );
      values.push(it);
      sum += it;
      if (it >= maxIter * 0.85) interior++;
      else if (it > 5) midBand++;
    }
  }
  const mean = sum / values.length;
  let sq = 0;
  for (const v of values) sq += (v - mean) * (v - mean);
  const stdDev = Math.sqrt(sq / values.length);
  const hasBoundary = interior > 0 && interior < values.length;
  return stdDev + midBand * 2.5 + (hasBoundary ? 30.0 : 0.0);
}

function findInteriorAnchor(
  currentX: number,
  currentY: number,
  preset: FractalPresetSpec,
  mode: string,
  maxIter: number,
): { x: number; y: number } {
  const candidates = [
    { x: currentX, y: currentY },
    { x: preset.centerX, y: preset.centerY },
    { x: 0.0, y: 0.0 },
    { x: -0.5, y: 0.0 },
    { x: -0.1, y: 0.0 },
    { x: -0.45, y: -0.5 },
  ];
  let best = candidates[1];
  let bestIter = -1;
  for (const pt of candidates) {
    if (Math.abs(pt.x) > 2.5 || Math.abs(pt.y) > 2.5) continue;
    const it = evaluateFractalPoint(pt.x, pt.y, preset, mode, maxIter);
    if (it > bestIter) {
      bestIter = it;
      best = pt;
    }
    if (it >= maxIter * 0.85) return pt;
  }
  for (let gy = -4; gy <= 4; gy++) {
    for (let gx = -5; gx <= 3; gx++) {
      const x = gx * 0.25;
      const y = gy * 0.25;
      const it = evaluateFractalPoint(x, y, preset, mode, maxIter);
      if (it > bestIter) {
        bestIter = it;
        best = { x, y };
      }
    }
  }
  return best;
}

// Finds the nearest fractal boundary from the viewer's current coordinates
// (using ray marching + 24-step bisection between interior and exterior) and
// snaps pan_x, pan_y and zoom onto it.
export function snapFractalToEdge(params: ParamValues): ParamValues {
  const preset = presetFor(params);
  const mode = String(params['mode'] ?? 'overlay');
  const maxIter = clamp(Number(params['iterations'] ?? 100), 30, 300);
  let zoom = Number(params['zoom'] ?? 0);
  if (zoom > 8) zoom = 5.0;
  else if (zoom < 0) zoom = 1.0;

  const currentX = preset.centerX + Number(params['pan_x'] ?? 0);
  const currentY = preset.centerY + Number(params['pan_y'] ?? 0);
  const interior = findInteriorAnchor(currentX, currentY, preset, mode, maxIter);

  const dx = currentX - interior.x;
  const dy = currentY - interior.y;
  const baseAngle = Math.hypot(dx, dy) > 1e-5 ? Math.atan2(dy, dx) : 0.85;
  const offsets = [0, 0.25, -0.25, 0.6, -0.6, 1.1, -1.1, 1.8, -1.8, Math.PI];

  const effectiveZoom = preset.baseZoom * Math.pow(2, zoom);
  const span = 1.2 / Math.max(effectiveZoom, 0.5);

  let bestX = interior.x;
  let bestY = interior.y;
  let bestScore = -1;

  for (const offset of offsets) {
    const angle = baseAngle + offset;
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);

    let inX = interior.x;
    let inY = interior.y;
    let outX = interior.x + dirX * 2.2;
    let outY = interior.y + dirY * 2.2;

    let prevX = inX;
    let prevY = inY;
    for (let s = 1; s <= 16; s++) {
      const r = (s / 16) * 2.2;
      const tx = interior.x + dirX * r;
      const ty = interior.y + dirY * r;
      const it = evaluateFractalPoint(tx, ty, preset, mode, maxIter);
      if (it >= maxIter * 0.65) {
        prevX = tx;
        prevY = ty;
      } else {
        inX = prevX;
        inY = prevY;
        outX = tx;
        outY = ty;
        break;
      }
    }

    for (let b = 0; b < 24; b++) {
      const midX = 0.5 * (inX + outX);
      const midY = 0.5 * (inY + outY);
      const it = evaluateFractalPoint(midX, midY, preset, mode, maxIter);
      if (it >= maxIter * 0.65) {
        inX = midX;
        inY = midY;
      } else {
        outX = midX;
        outY = midY;
      }
    }

    const edgeX = clamp(0.5 * (inX + outX), preset.centerX + PAN_MIN, preset.centerX + PAN_MAX);
    const edgeY = clamp(0.5 * (inY + outY), preset.centerY + PAN_MIN, preset.centerY + PAN_MAX);
    const score =
      edgeScoreAt(edgeX, edgeY, span, preset, mode, maxIter) -
      Math.min(12.0, Math.hypot(edgeX - currentX, edgeY - currentY) * 3.0);

    if (score > bestScore) {
      bestScore = score;
      bestX = edgeX;
      bestY = edgeY;
    }
  }

  return {
    ...params,
    pan_x: roundPan(bestX - preset.centerX),
    pan_y: roundPan(bestY - preset.centerY),
    zoom: roundZoom(zoom),
  };
}
