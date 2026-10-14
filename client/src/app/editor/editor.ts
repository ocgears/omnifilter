import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Alerts } from '../alerts/alerts';
import { errorMessage } from '../auth.service';
import { Gallery } from '../gallery/gallery';
import { Device, Filter, FilterParam, Layer, ParamValues, Photo, Preset } from '../models';
import { PhotoApi } from '../photo-api.service';
import { LiveCamera, cameraSupported } from './live-camera';
import { LivePreview } from './live-preview';
import { PhotoFileError, imageFrom, readPhoto } from './photo-file';
import { DraftStore } from './draft-store';
import { EditHistory, StackState } from './history';
import { PreviewEngine, decodePhoto, stackLayers } from './preview-engine';
import {
  filterLabel,
  findFilter,
  groupFilters,
  layersFromPhoto,
  layersFromPreset,
  missingFilters,
  newLayer,
  paramsFor,
  transformRequest,
} from './stack';
import { ImageDataCanvas, renderThumbnails } from './thumbnails';

// How long after an edit the draft is saved.
const DRAFT_SAVE_MS = 300;

// The longer side of the preset thumbnails, in pixels (they show at 72 CSS
// pixels, so this is sharp on 2x screens).
const THUMB_SIZE = 160;

// The main page: pick a photo, build a stack of filters (or start from a
// preset look), transform it on the server, and see the saved results.
@Component({
  selector: 'of-editor',
  imports: [Alerts, Gallery, ImageDataCanvas, LiveCamera, LivePreview],
  templateUrl: './editor.html',
  styleUrl: './editor.scss',
  host: {
    '(document:paste)': 'onPaste($event)',
    '(document:keydown)': 'onKeydown($event)',
    '(document:pointerdown)': 'closeHistory($event)',
  },
})
export class Editor {
  private readonly api = inject(PhotoApi);
  private readonly previewEngine = inject(PreviewEngine);
  private readonly drafts = inject(DraftStore);

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
  // Undo and redo for the stack, and the list of edits.
  readonly history = new EditHistory(this.stackState());
  private readonly historyMenu = viewChild<ElementRef<HTMLDetailsElement>>('historyMenu');

  // The picked photo, as a data URL.
  readonly source = signal<string | null>(null);
  readonly sourceName = signal('');
  readonly dragging = signal(false);
  readonly transforming = signal(false);
  // The live camera (where the browser can open one).
  readonly camera = cameraSupported();
  readonly cameraOn = signal(false);

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

  // Whether the photo or stack has changed since the page opened, so a draft
  // that arrives late doesn't replace them.
  private touched = false;
  private draftTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.loadFilters();
    this.loadPhotos();
    this.restoreDraft();
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
      // Layers filled in before the list arrived (say, from a preset or a
      // draft) get the defaults for whatever settings they didn't give.
      this.checkHistory();
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

  // ---- the draft: the photo and stack, kept in the browser ----

  private async restoreDraft(): Promise<void> {
    const draft = await this.drafts.load();
    if (this.touched) return;
    if (draft.photo?.source) {
      this.source.set(draft.photo.source);
      this.sourceName.set(draft.photo.name);
    }
    if (draft.stack && this.history.restore(draft.stack.steps, draft.stack.index)) {
      if (this.filtersLoaded()) this.checkHistory();
      this.show(this.history.current()!.state);
    }
  }

  private savePhotoDraft(): void {
    this.touched = true;
    const source = this.source();
    this.drafts.savePhoto(source ? { source, name: this.sourceName() } : null);
  }

  private saveStackDraft(): void {
    this.touched = true;
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(
      () => this.drafts.saveStack({ steps: this.history.steps(), index: this.history.index() }),
      DRAFT_SAVE_MS,
    );
  }

  // ---- undo and redo ----

  private stackState(): StackState {
    return { layers: this.layers(), preset: this.selectedPreset() };
  }

  private show(state: StackState): void {
    this.layers.set(state.layers);
    this.selectedPreset.set(state.preset);
  }

  // Records the stack as it is now as an edit.
  private commit(label: string, key?: string): void {
    this.history.record(label, this.stackState(), key);
    this.saveStackDraft();
  }

  undo(): void {
    const state = this.history.undo();
    if (state) this.show(state);
    this.saveStackDraft();
  }

  redo(): void {
    const state = this.history.redo();
    if (state) this.show(state);
    this.saveStackDraft();
  }

  goTo(index: number): void {
    const state = this.history.jump(index);
    if (state) this.show(state);
    this.saveStackDraft();
  }

  // The history list closes on a tap or click anywhere else, or Escape.
  closeHistory(event: Event): void {
    const menu = this.historyMenu()?.nativeElement;
    if (menu?.open && !menu.contains(event.target as Node)) menu.open = false;
  }

  // Ctrl+Z (Cmd+Z on a Mac) undoes; with Shift, or Ctrl+Y, redoes. Left to the
  // browser in text boxes, which have their own undo.
  onKeydown(event: KeyboardEvent): void {
    const menu = this.historyMenu()?.nativeElement;
    if (event.key === 'Escape' && menu?.open) {
      menu.open = false;
      menu.querySelector('summary')?.focus();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const target = event.target;
    if (target instanceof Element && target.closest('textarea, [contenteditable]')) return;
    if (target instanceof HTMLInputElement && !['range', 'file'].includes(target.type)) return;
    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey) this.undo();
    else if ((key === 'z' && event.shiftKey) || key === 'y') this.redo();
    else return;
    event.preventDefault();
  }

  // Once the filter list is known: every step's layers get the defaults for
  // settings they didn't give, and filters this server doesn't have are taken
  // out (a draft could come from before a filter went away).
  private checkHistory(): void {
    const filters = this.filters();
    const gone = new Set<string>();
    const fill = (layers: Layer[]): Layer[] =>
      layers.map((l) => {
        if (!l.tOption) return l;
        if (!findFilter(filters, l.tOption)) {
          gone.add(l.tOption);
          return { ...l, tOption: null, params: {} };
        }
        return { ...l, params: paramsFor(filters, l.tOption, l.params) };
      });
    this.history.mapStates((state) => ({ ...state, layers: fill(state.layers) }));
    this.layers.update(fill);
    if (gone.size) {
      this.addError(
        "This server can't run " + [...gone].join(', ') + ', so it was taken out of the stack.',
      );
    }
  }

  // ---- the photo ----

  async usePhoto(file: File | null | undefined): Promise<void> {
    if (!file) return;
    try {
      this.source.set(await readPhoto(file));
      this.sourceName.set(file.name);
      this.savePhotoDraft();
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

  // A photo taken with the live camera.
  useCapture(dataUrl: string): void {
    this.source.set(dataUrl);
    this.sourceName.set('Camera photo');
    this.cameraOn.set(false);
    this.savePhotoDraft();
  }

  clearPhoto(): void {
    this.source.set(null);
    this.sourceName.set('');
    this.savePhotoDraft();
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
      this.commit('Build your own');
      return;
    }
    if (this.missing(preset).length) {
      this.selectedPreset.set(null);
      this.addError(this.missingMessage(preset));
      return;
    }
    this.layers.set(layersFromPreset(this.filters(), preset));
    this.selectedPreset.set(preset.name);
    this.commit(preset.label + ' look');
  }

  // The stack a saved photo was made with, to use on this photo.
  useSettings(photo: Photo): void {
    const layers = layersFromPhoto(this.filters(), photo).slice(0, this.maxLayers());
    if (!layers.length) return;
    this.layers.set(layers);
    this.selectedPreset.set(null);
    this.commit('Settings from a saved photo');
    this.messages.update((list) => [
      ...list,
      'Using the settings from that photo. Undo puts back the ones you had.',
    ]);
  }

  // How an edit to a layer is described in the history, e.g. "Sepia: Amount 60".
  private layerName(index: number): string {
    const name = this.layers()[index]?.tOption;
    return name ? filterLabel(this.filters(), name) : 'Layer ' + (index + 1);
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
    this.commit('Layer ' + (index + 1) + ': ' + filterLabel(this.filters(), tOption));
  }

  // Sliders change the stack as they move (for the live preview) with
  // done = false, and are recorded as an edit when let go.
  setParam(index: number, param: FilterParam, raw: string, done = true): void {
    const value = param.type === 'range' ? Number(raw) : raw;
    this.updateLayer(index, (l) => ({
      ...l,
      params: { ...l.params, [param.name]: value } as ParamValues,
    }));
    if (!done) return;
    const shown =
      param.type === 'select' ? (param.options.find((o) => o.value === value)?.label ?? raw) : raw;
    this.commit(
      this.layerName(index) + ': ' + param.label + ' ' + shown,
      'param:' + index + ':' + param.name,
    );
  }

  setAmount(index: number, raw: string, done = true): void {
    this.updateLayer(index, (l) => ({ ...l, amount: Number(raw) }));
    if (done) this.commit(this.layerName(index) + ': strength ' + raw + '%', 'amount:' + index);
  }

  setBlend(index: number, blend: string): void {
    this.updateLayer(index, (l) => ({ ...l, blend }));
    this.commit(this.layerName(index) + ': ' + this.blendLabel(blend) + ' blend');
  }

  blendLabel(value: string): string {
    return this.blendModes().find((b) => b.value === value)?.label ?? value;
  }

  addLayer(): void {
    if (this.layers().length >= this.maxLayers()) return;
    this.layers.update((layers) => [...layers, newLayer()]);
    this.selectedPreset.set(null);
    this.commit('Added a layer');
  }

  removeLayer(index: number): void {
    const name = this.layerName(index);
    this.layers.update((layers) => {
      const rest = layers.filter((_, i) => i !== index);
      return rest.length ? rest : [newLayer()];
    });
    this.selectedPreset.set(null);
    this.commit('Removed ' + name);
  }

  moveLayer(index: number, by: number): void {
    const to = index + by;
    const layers = [...this.layers()];
    if (to < 0 || to >= layers.length) return;
    const name = this.layerName(index);
    const [layer] = layers.splice(index, 1);
    layers.splice(to, 0, layer);
    this.layers.set(layers);
    this.selectedPreset.set(null);
    this.commit('Moved ' + name + (by < 0 ? ' up' : ' down'));
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
