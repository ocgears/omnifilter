import { CPU_KERNELS, CpuArgs, lumaBin } from './cpu-kernels';

const px = (r: number, g: number, b: number, a = 255) =>
  (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;

// Runs a CPU kernel on buffers given as word arrays; returns them after.
function run(
  name: string,
  buffers: Record<string, Uint32Array>,
  scalars: Record<string, number>,
  global: [number, number],
): Record<string, Uint32Array> {
  const args: CpuArgs = {
    words: (n) => Uint32Array.from(buffers[n]),
    store: (n, w) => (buffers[n] = Uint32Array.from(w)),
    scalar: (n) => scalars[n],
    global,
  };
  CPU_KERNELS[name](args);
  return buffers;
}

describe('the kernels WebGL2 runs on the CPU', () => {
  it('bins luma as the GPU does', () => {
    expect(lumaBin(px(0, 0, 0))).toBe(0);
    expect(lumaBin(px(255, 255, 255))).toBe(255);
    expect(lumaBin(px(255, 0, 0))).toBe(54);
    expect(lumaBin(px(0, 255, 0))).toBe(182);
  });

  it('counts the visible pixels into the histograms', () => {
    const src = Uint32Array.of(px(10, 20, 30), px(10, 0, 0), px(99, 99, 99, 0));
    const { hist } = run('histogram', { src, hist: new Uint32Array(1024) }, { count: 3 }, [256, 1]);
    const h = new Int32Array(hist.buffer);
    expect(h[10]).toBe(2);
    expect(h[256 + 20]).toBe(1);
    expect(h[512 + 30]).toBe(1);
    expect(h[99]).toBe(0);
    expect(h.slice(768).reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('makes an equalisation curve from the luma histogram', () => {
    const hist = new Int32Array(1024);
    hist[768 + 10] = 1;
    hist[768 + 200] = 3;
    const { lut } = run(
      'equalize_lut',
      { hist: new Uint32Array(hist.buffer), lut: new Uint32Array(257) },
      {},
      [256, 1],
    );
    const l = new Float32Array(lut.buffer);
    expect(l[0]).toBe(0);
    expect(l[10]).toBe(0);
    expect(l[200]).toBe(1);
    expect(l[256]).toBe(1);
  });

  it('plants seeds and sums cells in 64 bits', () => {
    const seeds = new Uint32Array(Int32Array.of(1, 0, 0, 1).buffer);
    const { cells } = run(
      'jfa_plant',
      { seeds, cells: new Uint32Array(new Int32Array(4).fill(-1).buffer) },
      { width: 2, height: 2, count: 2 },
      [64, 1],
    );
    expect(Array.from(new Int32Array(cells.buffer))).toEqual([-1, 0, 1, -1]);

    const src = Uint32Array.of(px(255, 0, 0), px(255, 255, 255), px(0, 0, 255), px(0, 0, 0, 0));
    const sums = new Uint32Array(18);
    sums[0] = 0xffffffff;
    const out = run(
      'cell_accumulate',
      { src, cells: new Uint32Array(Int32Array.of(0, 0, 1, -1).buffer), sums },
      { width: 2, height: 2 },
      [2, 2],
    )['sums'];
    // Red: 0xffffffff + 255 * 255 * 2, carried into the high word.
    expect(out[0] + out[1] * 2 ** 32).toBe(0xffffffff + 2 * 255 * 255);
    expect(out[6]).toBe(510);
    expect(out[8]).toBe(2);
    expect(out[9 + 4]).toBe(255 * 255);
    expect(out[9 + 8]).toBe(1);
  });

  it('makes contrast-limited curves for each tile', () => {
    const src = new Uint32Array(16).map((_, i) => px(i * 16, i * 16, i * 16));
    const { hists } = run(
      'clahe_hist',
      { src, hists: new Uint32Array(512) },
      { width: 4, height: 4, tiles_x: 2, tiles_y: 1 },
      [512, 1],
    );
    const h = new Int32Array(hists.buffer);
    expect(h.slice(0, 256).reduce((a, b) => a + b, 0)).toBe(8);
    const { luts } = run(
      'clahe_lut',
      { hists, luts: new Uint32Array(512) },
      { clip_limit: 2 },
      [512, 1],
    );
    const l = new Float32Array(luts.buffer);
    expect(l[255]).toBeCloseTo(1, 5);
    for (let b = 1; b < 256; b++) expect(l[b]).toBeGreaterThanOrEqual(l[b - 1]);
  });

  it('finds the levels that clip a share of each channel', () => {
    const hist = new Int32Array(1024);
    for (let c = 0; c < 4; c++) {
      hist[c * 256 + 20] = 50;
      hist[c * 256 + 230] = 50;
    }
    const { params } = run(
      'auto_levels_params',
      { hist: new Uint32Array(hist.buffer), params: new Uint32Array(6) },
      { clip: 0.01, linked: 0 },
      [64, 1],
    );
    const p = new Float32Array(params.buffer);
    expect(p[0]).toBeCloseTo(20 / 255, 6);
    expect(p[1]).toBeCloseTo(230 / 255, 6);
  });
});
