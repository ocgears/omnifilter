import { madeSummary, timingParts } from './result-card';

const result = {
  file: new Blob(),
  width: 4032,
  height: 3024,
  ranAt: null,
  device: 'Apple GPU',
  timings: { decode: 310, upload: 42, filters: 1120, readback: 61, encode: 404, total: 1937 },
};

describe('the result card', () => {
  it('says how big the photo is, what made it and how fast', () => {
    expect(madeSummary(result)).toBe('12.2 MP, made on Apple GPU in 1.9 s (6.3 MP/s)');
  });

  it('says where the time went', () => {
    expect(timingParts(result)).toBe(
      'decode 0.3 s · to the GPU 0.04 s · filters 1.1 s · back 0.06 s · encode 0.4 s',
    );
  });
});
