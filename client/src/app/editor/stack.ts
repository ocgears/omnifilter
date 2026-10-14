// The filter stack being edited, as plain functions so they're easy to test.
// Filters are applied top to bottom, each laid over the result of the ones
// above with its amount and blend mode (server/lib/stack.js).
import { Filter, Layer, ParamValues, Photo, Preset, TransformRequest } from '../models';

export function newLayer(): Layer {
  return { tOption: null, params: {}, amount: 100, blend: 'normal' };
}

export function findFilter(filters: readonly Filter[], name: string | null | undefined) {
  return name ? filters.find((f) => f.name === name) : undefined;
}

// A filter's settings: its defaults, overridden by any given. Until the
// filter list has loaded (or for a filter it doesn't have), the given
// settings are kept as they are.
export function paramsFor(
  filters: readonly Filter[],
  name: string | null,
  given?: ParamValues,
): ParamValues {
  const filter = findFilter(filters, name);
  if (!filter) return { ...given };
  const params: ParamValues = {};
  for (const p of filter.params) {
    params[p.name] = given && given[p.name] !== undefined ? given[p.name] : p.default;
  }
  return params;
}

// The filters a preset uses that the server can't run. Empty until the
// filter list has loaded.
export function missingFilters(
  filters: readonly Filter[],
  loaded: boolean,
  preset: Preset,
): string[] {
  if (!loaded) return [];
  return preset.stack.map((item) => item.tOption).filter((name) => !findFilter(filters, name));
}

export function layersFromPreset(filters: readonly Filter[], preset: Preset): Layer[] {
  return preset.stack.map((item) => ({
    tOption: item.tOption,
    params: paramsFor(filters, item.tOption, item.params),
    amount: item.amount ?? 100,
    blend: item.blend || 'normal',
  }));
}

// The stack a saved photo was made with, to use again. Empty for a photo
// saved as it was.
export function layersFromPhoto(filters: readonly Filter[], photo: Photo): Layer[] {
  let used: NonNullable<Photo['tStack']> = photo.tStack ?? [];
  if (!used.length && photo.tOption) used = [{ tOption: photo.tOption, tParams: photo.tParams }];
  return used.map((item) => ({
    tOption: item.tOption,
    params: paramsFor(filters, item.tOption, item.tParams),
    amount: typeof item.amount === 'number' ? item.amount : 100,
    blend: item.blend || 'normal',
  }));
}

// The body for POST /newcontent. Layers with no filter are skipped; with
// none left, the original is saved. A single filter at full strength is
// sent the simple way.
export function transformRequest(content: string, layers: readonly Layer[]): TransformRequest {
  const used = layers.filter((layer): layer is Layer & { tOption: string } => !!layer.tOption);
  if (!used.length) return { content, tOption: '' };
  if (used.length === 1 && used[0].amount >= 100 && used[0].blend === 'normal') {
    return { content, tOption: used[0].tOption, params: used[0].params };
  }
  return {
    content,
    stack: used.map((layer) => ({
      tOption: layer.tOption,
      params: layer.params,
      amount: layer.amount,
      blend: layer.blend,
    })),
  };
}

export function filterLabel(filters: readonly Filter[], name: string | null | undefined): string {
  return findFilter(filters, name)?.label ?? (name || 'Original');
}

// What a saved photo had applied, e.g. "Sepia + Vignette".
export function photoLabel(filters: readonly Filter[], photo: Photo): string {
  if (photo.tStack?.length) {
    return photo.tStack.map((layer) => filterLabel(filters, layer.tOption)).join(' + ');
  }
  return filterLabel(filters, photo.tOption);
}

// Filters grouped for the picker's <optgroup>s, in the server's order.
export function groupFilters(filters: readonly Filter[]): { group: string; filters: Filter[] }[] {
  const groups: { group: string; filters: Filter[] }[] = [];
  for (const filter of filters) {
    let entry = groups.find((g) => g.group === filter.group);
    if (!entry) groups.push((entry = { group: filter.group, filters: [] }));
    entry.filters.push(filter);
  }
  return groups;
}
