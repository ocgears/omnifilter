import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Alerts } from '../alerts/alerts';
import { errorMessage } from '../auth.service';
import { Gallery } from '../gallery/gallery';
import { Device, Filter, FilterParam, Layer, ParamValues, Photo, Preset } from '../models';
import { PhotoApi } from '../photo-api.service';
import { LivePreview } from './live-preview';
import { PhotoFileError, imageFrom, readPhoto } from './photo-file';
import { PreviewEngine, decodePhoto, stackLayers } from './preview-engine';
import {
  findFilter,
  groupFilters,
  layersFromPreset,
  missingFilters,
  newLayer,
  paramsFor,
  transformRequest,
} from './stack';
import { ImageDataCanvas, renderThumbnails } from './thumbnails';

// The longer side of the preset thumbnails, in pixels (they show at 72 CSS
// pixels, so this is sharp on 2x screens).
const THUMB_SIZE = 160;

// The main page: pick a photo, build a stack of filters (or start from a
// preset look), transform it on the server, and see the saved results.
@Component({
  selector: 'of-editor',
  imports: [Alerts, Gallery, ImageDataCanvas, LivePreview],
  templateUrl: './editor.html',
  styleUrl: './editor.scss',
  host: {
    '(document:paste)': 'onPaste($event)',
  },
})
export class Editor {
  private readonly api = inject(PhotoApi);
  private readonly previewEngine = inject(PreviewEngine);

  readonly errors = signal<string[]>([]);
  readonly messages = signal<string[]>([]);

  readonly filters = signal<Filter[]>([]);
  // Until the filter list arrives, presets can't be checked against it.
  readonly filtersLoaded = signal(false);
  readonly filterGroups = computed(() => groupFilters(this.filters()));
  readonly presets = signal<Preset[]>([]);
  readonly maxLayers = signal(8);
  readonly blendModes = signal<{ value: string; label: string }[]>([]);
  readonly blendModeNames = computed(() => this.blendModes().map((b) => b.value));
  readonly device = signal<Device | null>(null);

  readonly layers = signal<Layer[]>([newLayer()]);
  readonly selectedPreset = signal<string | null>(null);
  readonly preset = computed(() => this.presets().find((p) => p.name === this.selectedPreset()));

  // The picked photo, as a data URL.
  readonly source = signal<string | null>(null);
  readonly sourceName = signal('');
  readonly dragging = signal(false);
  readonly transforming = signal(false);

  readonly photos = signal<Photo[]>([]);
  // The photo just made, to point it out.
  readonly latestId = signal<string | null>(null);

  // Each preset look on the user's photo, by preset name ('' for the photo
  // as it is), rendered on this device's GPU where there is one.
  readonly thumbnails = signal<Map<string, ImageData>>(new Map());
  private thumbnailRun = 0;

  readonly deviceKind = computed(() => {
    const type = this.device()?.type;
    if (type === 'gpu') return 'GPU';
    if (type === 'cpu') return 'CPU';
    return type || 'server';
  });

  constructor() {
    this.loadFilters();
    this.loadPhotos();
    effect(() => {
      const source = this.source();
      const presets = this.presets();
      const loaded = this.filtersLoaded();
      const modes = this.blendModeNames();
      untracked(() => this.renderThumbnails(source, presets, loaded, modes));
    });
  }

  private async renderThumbnails(
    source: string | null,
    presets: Preset[],
    loaded: boolean,
    modes: string[],
  ): Promise<void> {
    const run = ++this.thumbnailRun;
    if (!source || !presets.length || !loaded || !modes.length) {
      this.thumbnails.set(new Map());
      return;
    }
    try {
      const engine = await this.previewEngine.get();
      if (!engine || run !== this.thumbnailRun) return;
      const photo = await decodePhoto(source, THUMB_SIZE);
      const stacks = [{ key: '', layers: [] as ReturnType<typeof stackLayers> }].concat(
        presets
          .filter((p) => !this.missing(p).length)
          .map((p) => ({ key: p.name, layers: stackLayers(layersFromPreset(this.filters(), p)) })),
      );
      const images = await renderThumbnails(engine, photo, stacks, modes);
      if (run === this.thumbnailRun) this.thumbnails.set(images);
    } catch (err) {
      console.error('Thumbnails:', err);
    }
  }

  private addError(message: string): void {
    this.errors.update((list) => [...list, message]);
  }

  dismissError(index: number): void {
    this.errors.update((list) => list.filter((_, i) => i !== index));
  }

  dismissMessage(index: number): void {
    this.messages.update((list) => list.filter((_, i) => i !== index));
  }

  private async loadFilters(): Promise<void> {
    this.api.device().then(
      (device) => this.device.set(device),
      () => this.device.set(null),
    );
    this.api.presets().then(
      (res) => {
        this.presets.set(res.presets);
        this.maxLayers.set(res.maxLayers);
        const blend = res.layerParams.find((p) => p.name === 'blend');
        this.blendModes.set(blend?.type === 'select' ? blend.options : []);
      },
      () => this.addError('Could not load the preset looks.'),
    );
    try {
      // Hide filters the server's device can't run.
      const filters = (await this.api.filters()).filter((f) => f.available !== false);
      this.filters.set(filters);
      this.filtersLoaded.set(true);
      // Layers filled in before the list arrived (say, from a preset) get the
      // defaults for whatever settings they didn't give.
      this.layers.update((layers) =>
        layers.map((l) =>
          l.tOption ? { ...l, params: paramsFor(filters, l.tOption, l.params) } : l,
        ),
      );
      const preset = this.preset();
      if (preset && this.missing(preset).length) {
        this.addError(this.missingMessage(preset));
        this.selectedPreset.set(null);
      }
    } catch {
      this.addError('Could not load the list of filters.');
    }
  }

  private async loadPhotos(): Promise<void> {
    try {
      this.photos.set(await this.api.all());
    } catch (err) {
      this.addError(errorMessage(err, 'Could not load your photos.'));
    }
  }

  // ---- the photo ----

  async usePhoto(file: File | null | undefined): Promise<void> {
    if (!file) return;
    try {
      this.source.set(await readPhoto(file));
      this.sourceName.set(file.name);
    } catch (err) {
      this.addError(err instanceof PhotoFileError ? err.message : 'Could not read that file.');
    }
  }

  onFilePicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.usePhoto(input.files?.[0]);
    // Picking the same file again should still work.
    input.value = '';
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(true);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    this.usePhoto(imageFrom(event.dataTransfer));
  }

  onPaste(event: ClipboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, select')) return;
    const file = imageFrom(event.clipboardData);
    if (file) {
      event.preventDefault();
      this.usePhoto(file);
    }
  }

  clearPhoto(): void {
    this.source.set(null);
    this.sourceName.set('');
  }

  // ---- presets and layers ----

  missing(preset: Preset): string[] {
    return missingFilters(this.filters(), this.filtersLoaded(), preset);
  }

  private missingMessage(preset: Preset): string {
    return (
      'The ' +
      preset.label +
      " preset needs filters this server can't run: " +
      this.missing(preset).join(', ') +
      '.'
    );
  }

  // Replaces the layers with a preset's, which can then be adjusted.
  applyPreset(preset: Preset | null): void {
    if (!preset) {
      this.selectedPreset.set(null);
      return;
    }
    if (this.missing(preset).length) {
      this.selectedPreset.set(null);
      this.addError(this.missingMessage(preset));
      return;
    }
    this.layers.set(layersFromPreset(this.filters(), preset));
    this.selectedPreset.set(preset.name);
  }

  filterOf(layer: Layer): Filter | undefined {
    return findFilter(this.filters(), layer.tOption);
  }

  // Any change to the stack means it's no longer the selected preset.
  private updateLayer(index: number, change: (layer: Layer) => Layer): void {
    this.layers.update((layers) => layers.map((l, i) => (i === index ? change(l) : l)));
    this.selectedPreset.set(null);
  }

  // Each filter starts from its default settings.
  setFilter(index: number, name: string): void {
    const tOption = name || null;
    this.updateLayer(index, (l) => ({ ...l, tOption, params: paramsFor(this.filters(), tOption) }));
  }

  setParam(index: number, param: FilterParam, raw: string): void {
    const value = param.type === 'range' ? Number(raw) : raw;
    this.updateLayer(index, (l) => ({
      ...l,
      params: { ...l.params, [param.name]: value } as ParamValues,
    }));
  }

  setAmount(index: number, raw: string): void {
    this.updateLayer(index, (l) => ({ ...l, amount: Number(raw) }));
  }

  setBlend(index: number, blend: string): void {
    this.updateLayer(index, (l) => ({ ...l, blend }));
  }

  blendLabel(value: string): string {
    return this.blendModes().find((b) => b.value === value)?.label ?? value;
  }

  addLayer(): void {
    if (this.layers().length >= this.maxLayers()) return;
    this.layers.update((layers) => [...layers, newLayer()]);
    this.selectedPreset.set(null);
  }

  removeLayer(index: number): void {
    this.layers.update((layers) => {
      const rest = layers.filter((_, i) => i !== index);
      return rest.length ? rest : [newLayer()];
    });
    this.selectedPreset.set(null);
  }

  moveLayer(index: number, by: number): void {
    const to = index + by;
    const layers = [...this.layers()];
    if (to < 0 || to >= layers.length) return;
    const [layer] = layers.splice(index, 1);
    layers.splice(to, 0, layer);
    this.layers.set(layers);
    this.selectedPreset.set(null);
  }

  // ---- transforming ----

  async transform(): Promise<void> {
    const source = this.source();
    if (!source) {
      this.addError('Choose a photo first.');
      return;
    }
    if (this.transforming()) return;
    const body = transformRequest(source, this.layers());
    if (body.tOption === '') {
      this.messages.update((list) => [...list, 'No filter chosen, so the original was saved.']);
    }
    this.transforming.set(true);
    try {
      const photo = await this.api.transform(body);
      this.photos.update((photos) => [photo, ...photos]);
      this.latestId.set(photo._id);
    } catch (err) {
      this.addError(errorMessage(err, 'Could not transform the photo.'));
    } finally {
      this.transforming.set(false);
    }
  }

  async deletePhoto(photo: Photo): Promise<void> {
    try {
      const res = await this.api.delete(photo);
      this.photos.update((photos) => photos.filter((p) => p !== photo));
      if (res?.msg) this.messages.update((list) => [...list, res.msg]);
    } catch (err) {
      this.addError(errorMessage(err, 'Could not delete that photo.'));
    }
  }
}
