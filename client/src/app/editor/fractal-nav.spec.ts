import {
  FRACTAL_PRESETS,
  evaluateFractalPoint,
  isFractalMoved,
  panFractal,
  resetFractalView,
  snapFractalToEdge,
  zoomFractal,
} from './fractal-nav';

describe('fractal navigation', () => {
  const baseParams = {
    mode: 'overlay',
    preset: 'mandelbrot',
    palette: 'cosmic',
    zoom: 0,
    pan_x: 0,
    pan_y: 0,
    iterations: 100,
    blend_amount: 75,
  };

  it('pans proportional to the current zoom and clamps within bounds', () => {
    const moved = panFractal(baseParams, 1, -1);
    expect(Number(moved['pan_x'])).toBeGreaterThan(0);
    expect(Number(moved['pan_y'])).toBeLessThan(0);
    expect(isFractalMoved(moved)).toBe(true);

    const deepZoom = { ...baseParams, zoom: 6 };
    const deepMoved = panFractal(deepZoom, 1, 0);
    expect(Number(deepMoved['pan_x'])).toBeGreaterThan(0);
    expect(Number(deepMoved['pan_x'])).toBeLessThan(Number(moved['pan_x']));
  });

  it('zooms in and out within the allowed range, and resets view', () => {
    const zoomedIn = zoomFractal(baseParams, 1.5);
    expect(zoomedIn['zoom']).toBe(1.5);
    const clampedMax = zoomFractal(baseParams, 99);
    expect(clampedMax['zoom']).toBe(14);
    const clampedMin = zoomFractal(baseParams, -99);
    expect(clampedMin['zoom']).toBe(-1);

    const reset = resetFractalView({ ...zoomedIn, pan_x: 0.42, pan_y: -0.18 });
    expect(reset['pan_x']).toBe(0);
    expect(reset['pan_y']).toBe(0);
    expect(reset['zoom']).toBe(0);
    expect(isFractalMoved(reset)).toBe(false);
  });

  it('snaps back to a fractal boundary when lost far outside or deep inside', () => {
    const preset = FRACTAL_PRESETS['mandelbrot'];
    const lostOutside = { ...baseParams, pan_x: 2.0, pan_y: 2.0, zoom: 12 };
    const snappedFromOutside = snapFractalToEdge(lostOutside);
    expect(Number(snappedFromOutside['zoom'])).toBeLessThanOrEqual(8);

    const cx = preset.centerX + Number(snappedFromOutside['pan_x']);
    const cy = preset.centerY + Number(snappedFromOutside['pan_y']);
    const iterAtEdge = evaluateFractalPoint(cx, cy, preset, 'overlay', 100);
    expect(iterAtEdge).toBeGreaterThan(5);

    const lostInside = { ...baseParams, pan_x: 0.4, pan_y: 0.0, zoom: 11 };
    const snappedFromInside = snapFractalToEdge(lostInside);
    const ix = preset.centerX + Number(snappedFromInside['pan_x']);
    const iy = preset.centerY + Number(snappedFromInside['pan_y']);
    const iterFromInside = evaluateFractalPoint(ix, iy, preset, 'overlay', 100);
    expect(iterFromInside).toBeGreaterThan(5);
  });
});
