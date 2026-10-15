import { FILTERS } from '../../testing/fixtures';
import { Preset } from '../models';
import {
  groupFilters,
  layersFromPhoto,
  layersFromPreset,
  missingFilters,
  newLayer,
  paramsFor,
  photoLabel,
  transformRequest,
} from './stack';

describe('the filter stack', () => {
  it('starts each filter from its defaults, overridden by any given settings', () => {
    expect(paramsFor(FILTERS, 'sepia')).toEqual({ amount: 80, tone: 'warm' });
    expect(paramsFor(FILTERS, 'sepia', { tone: 'cool', stray: 1 })).toEqual({
      amount: 80,
      tone: 'cool',
    });
  });

  it("keeps the given settings for a filter it doesn't know (yet)", () => {
    expect(paramsFor([], 'sepia', { amount: 10 })).toEqual({ amount: 10 });
    expect(paramsFor(FILTERS, null)).toEqual({});
  });

  it('sends no filter as the original', () => {
    expect(transformRequest('data:x', [newLayer()])).toEqual({ content: 'data:x', tOption: '' });
  });

  it('sends a single filter at full strength the simple way', () => {
    const layer = { ...newLayer(), tOption: 'blur', params: { radius: 5 } };
    expect(transformRequest('data:x', [layer, newLayer()])).toEqual({
      content: 'data:x',
      tOption: 'blur',
      params: { radius: 5 },
    });
  });

  it('sends one filter at partial strength, or several, as a stack without empty layers', () => {
    const blur = { ...newLayer(), tOption: 'blur', params: { radius: 5 }, amount: 40 };
    expect(transformRequest('data:x', [blur]).stack).toEqual([
      { tOption: 'blur', params: { radius: 5 }, amount: 40, blend: 'normal' },
    ]);
    const invert = { ...newLayer(), tOption: 'invert', blend: 'screen' };
    const body = transformRequest('data:x', [blur, newLayer(), invert]);
    expect(body.tOption).toBeUndefined();
    expect(body.stack?.map((l) => l.tOption)).toEqual(['blur', 'invert']);
    expect(body.stack?.[1].blend).toBe('screen');
  });

  const preset: Preset = {
    name: 'look',
    label: 'A look',
    stack: [
      { tOption: 'blur', params: { radius: 9 } },
      { tOption: 'sepia', amount: 50, blend: 'multiply' },
    ],
  };

  it('fills in layers from a preset, with defaults for unset settings', () => {
    expect(layersFromPreset(FILTERS, preset)).toEqual([
      { tOption: 'blur', params: { radius: 9 }, amount: 100, blend: 'normal' },
      { tOption: 'sepia', params: { amount: 80, tone: 'warm' }, amount: 50, blend: 'multiply' },
    ]);
  });

  it("lists the filters a preset needs that the server can't run, once it knows", () => {
    const blurOnly = FILTERS.slice(0, 1);
    expect(missingFilters(blurOnly, true, preset)).toEqual(['sepia']);
    expect(missingFilters(blurOnly, false, preset)).toEqual([]);
    expect(missingFilters(FILTERS, true, preset)).toEqual([]);
  });

  it('labels saved photos by what was applied', () => {
    expect(photoLabel(FILTERS, { _id: '1', content: '', tOption: 'invert' })).toBe('Invert');
    expect(photoLabel(FILTERS, { _id: '1', content: '', tOption: '' })).toBe('Original');
    expect(
      photoLabel(FILTERS, {
        _id: '1',
        content: '',
        tStack: [{ tOption: 'sepia' }, { tOption: 'gone' }],
      }),
    ).toBe('Sepia + gone');
  });

  it("groups filters in the server's order", () => {
    expect(groupFilters(FILTERS).map((g) => [g.group, g.filters.length])).toEqual([
      ['Blur', 1],
      ['Colour', 2],
    ]);
  });

  it("rebuilds the stack a saved photo was made with", () => {
    expect(
      layersFromPhoto(FILTERS, {
        _id: '1',
        content: '',
        tStack: [
          { tOption: 'sepia', tParams: { tone: 'cool' }, amount: 40, blend: 'multiply' },
          { tOption: 'blur' },
        ],
      }),
    ).toEqual([
      { tOption: 'sepia', params: { amount: 80, tone: 'cool' }, amount: 40, blend: 'multiply' },
      { tOption: 'blur', params: { radius: 3 }, amount: 100, blend: 'normal' },
    ]);
    expect(
      layersFromPhoto(FILTERS, { _id: '2', content: '', tOption: 'blur', tParams: { radius: 7 } }),
    ).toEqual([{ tOption: 'blur', params: { radius: 7 }, amount: 100, blend: 'normal' }]);
    expect(layersFromPhoto(FILTERS, { _id: '3', content: '', tOption: '', tStack: [] })).toEqual([]);
  });
});
