import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Alerts } from '../alerts/alerts';
import { AuthService, errorMessage as serverMessage } from '../auth.service';
import { BrowserStorageError } from '../browser-db';
import { Gallery } from '../gallery/gallery';
import { refocus } from '../focus';
import { downloadName } from '../photo-names';
import { GuestPhotos, LOCAL_ID, isLocal } from '../guest-photos';
import {
  Device,
  Filter,
  FilterParam,
  Layer,
  ParamValues,
  Photo,
  Preset,
  ServerSettings,
} from '../models';
import type { MadeOnDevice } from '../result-card/result-card';
import { ResultCard } from '../result-card/result-card';
import { PhotoApi, photoFile } from '../photo-api.service';
import { cameraSupported } from './camera-support';
import { LiveCamera } from './live-camera';
import { LivePreview } from './live-preview';
import {
  MAX_FILE_BYTES,
  PhotoFileError,
  fitForKeeping,
  fitPhoto,
  imageFrom,
  readPhoto,
} from './photo-file';
import { takeSharedPhoto } from './shared-photo';
import { DeviceTransform, DeviceTransformError } from './device-transform';
import { DraftStore } from './draft-store';
import { EditHistory, StackState } from './history';
import { PreviewEngine, previewPhoto, smallerPhoto, stackLayers } from './preview-engine';
import {
  filterLabel,
  findFilter,
  groupFilters,
  layersFromPhoto,
  layersFromPreset,
  madePhoto,
  missingFilters,
  newLayer,
  paramsFor,
  photoLabel,
  transformRequest,
} from './stack';
import { ImageDataCanvas, renderThumbnails } from './thumbnails';

// How long after an edit the draft is saved.
const DRAFT_SAVE_MS = 300;

// How many saved photos the gallery loads at a time.
const PHOTOS_PAGE = 24;

// The sample photo: the Apollo 17 crew's view of Earth (NASA's
// AS17-148-22727, from images.nasa.gov, credited to NASA as its media
// guidelines ask; see the README), at 12 megapixels, about what a phone
// takes.
export const SAMPLE_PHOTO = {
  url: '/images/samples/earth-apollo-17.jpg',
  name: 'Earth from Apollo 17 (NASA).jpg',
};

// The longer side of the preset thumbnails, in pixels (they show at 72 CSS
// pixels, so this is sharp on 2x screens).
const THUMB_SIZE = 160;

// The main page: pick a photo, build a stack of filters (or start from a
// preset look), transform it on the server, and see the saved results.
// Without an account it works as a guest: the server filters the photos but
// doesn't keep them, so they're kept in this browser, and can be added to an
// account later.
//
// Where the server says so (GET /settings: the hosted demo), Transform
// filters the photo at full size on this device's GPU instead, in a Web
// Worker; the result is offered to save or share, and kept on the server
// (or, for a guest, in this browser) only if asked, up to the server's limit.
@Component({
  selector: 'of-editor',
  imports: [Alerts, Gallery, ImageDataCanvas, LiveCamera, LivePreview, ResultCard, RouterLink],
  templateUrl: './editor.html',
  styleUrl: './editor.scss',
  host: {
    '(document:paste)': 'onPaste($event)',
    '(document:keydown)': 'onKeydown($event)',
    '(document:pointerdown)': 'closeHistory($event)',
    '(window:pagehide)': 'flushDraft()',
    '(document:visibilitychange)': 'flushDraft()',
  },
})
export class Editor {
  private readonly api = inject(PhotoApi);
  private readonly previewEngine = inject(PreviewEngine);
  private readonly drafts = inject(DraftStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly guestStore = inject(GuestPhotos);
  private readonly deviceTransform = inject(DeviceTransform);

  // Signed in, or trying it out as a guest.
  readonly signedIn = computed(() => !!this.auth.token());
  readonly settings = signal<ServerSettings | null>(null);
  // Whether Transform filters on this device's GPU rather than the server's.
  readonly onDevice = computed(() => {
    const s = this.settings();
    if (!s) return false;
    const where = this.signedIn() ? s.processing : s.guests;
    return where === 'device' || (where === 'device-first' && DeviceTransform.supported());
  });
  readonly deviceSupported = DeviceTransform.supported();
  // How many photos may be kept, or null for any number.
  readonly storageLimit = computed(() => this.settings()?.maxStoredPhotos ?? null);
  // How many photos are kept: those shown, and the server's not loaded yet.
  readonly photoCount = computed(() => this.photos().length + this.unloaded());
  readonly roomToKeep = computed(() => {
    const limit = this.storageLimit();
    return !limit || this.photoCount() < limit;
  });
  readonly keepText = computed(() => {
    const limit = this.storageLimit();
    const where = this.signedIn() ? 'Keep in gallery' : 'Keep in this browser';
    if (!limit) return where;
    if (!this.roomToKeep()) return 'Gallery full (' + limit + ' of ' + limit + ')';
    return where + ' (' + (this.photoCount() + 1) + ' of ' + limit + ')';
  });
  // A photo just made on this device, until it's kept or discarded.
  readonly made = signal<MadeOnDevice | null>(null);
  // When the server keeps a smaller copy of it than was made, says so.
  readonly keepNote = computed(() => {
    const side = this.settings()?.keepMaxSide;
    const made = this.made();
    if (!side || !made || !this.signedIn() || Math.max(made.width, made.height) <= side)
      return null;
    return (
      'The gallery keeps a copy ' + side + ' pixels on its longer side; Save keeps the full size.'
    );
  });
  readonly keeping = signal(false);
  readonly deviceProgress = this.deviceTransform.progress;
  // Photos made as a guest that are still in this browser, once signed in.
  readonly waitingPhotos = signal<Photo[]>([]);
  readonly importing = signal(false);
  readonly confirmDiscard = signal(false);

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
  private readonly stage = viewChild.required<ElementRef<HTMLElement>>('stage');
  private readonly actionBar = viewChild.required<ElementRef<HTMLElement>>('actionBar');

  // The picked photo, as a data URL.
  readonly source = signal<string | null>(null);
  readonly sourceName = signal('');
  readonly dragging = signal(false);
  readonly transforming = signal(false);
  // The live camera (where the browser can open one).
  readonly camera = cameraSupported();
  readonly cameraOn = signal(false);
  // Read out by screen readers when something finishes out of sight, such as
  // a photo added to the gallery further down.
  readonly announcement = signal('');

  readonly photos = signal<Photo[]>([]);
  // How many of the server's photos aren't loaded yet (they come a page at
  // a time), and whether the next page is on its way.
  readonly unloaded = signal(0);
  readonly loadingMore = signal(false);
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
    this.loadSettings();
    const wasSignedIn = this.signedIn();
    this.destroyRef.onDestroy(() => {
      this.deviceTransform.cancel();
      this.discardMade();
      // An edit not saved yet is saved on the way to another page, unless
      // that's because of signing out, which forgets the draft.
      if (wasSignedIn && !this.signedIn()) clearTimeout(this.draftTimer);
      else this.flushDraft();
    });
    this.loadFilters();
    this.loadPhotos();
    // A photo shared from another app comes after the draft, so it replaces
    // the draft's photo but keeps its filters.
    this.restoreDraft().finally(() => this.useSharedPhoto());
    afterNextRender(() => this.trackStickyParts());
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
      // From the copy the live preview decodes, not the photo again.
      const photo = await smallerPhoto(await previewPhoto(source), THUMB_SIZE);
      if (run !== this.thumbnailRun) return;
      const stacks = [{ key: '', layers: [] as ReturnType<typeof stackLayers> }].concat(
        presets
          .filter((p) => !this.missing(p).length)
          .map((p) => ({ key: p.name, layers: stackLayers(layersFromPreset(this.filters(), p)) })),
      );
      const images = await renderThumbnails(
        engine,
        photo,
        stacks,
        modes,
        () => run !== this.thumbnailRun,
      );
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
    const local = await this.guestStore.list();
    if (!this.signedIn()) {
      this.photos.set(local);
      return;
    }
    this.waitingPhotos.set(local);
    try {
      const page = await this.api.all(PHOTOS_PAGE);
      this.photos.set(page.photos);
      this.unloaded.set(Math.max(0, page.total - page.photos.length));
    } catch (err) {
      this.addError(errorMessage(err, 'Could not load your photos.'));
    }
  }

  // The next page of the server's photos, after the last one shown.
  async loadMorePhotos(): Promise<void> {
    const last = this.photos()
      .filter((p) => !isLocal(p))
      .at(-1);
    if (!last || this.loadingMore()) return;
    this.loadingMore.set(true);
    try {
      const page = await this.api.all(PHOTOS_PAGE, last);
      const shown = new Set(this.photos().map((p) => p._id));
      this.photos.update((list) => [...list, ...page.photos.filter((p) => !shown.has(p._id))]);
      this.unloaded.set(Math.max(0, page.total - this.photos().filter((p) => !isLocal(p)).length));
    } catch (err) {
      this.addError(errorMessage(err, 'Could not load more of your photos.'));
    } finally {
      this.loadingMore.set(false);
    }
  }

  // A server that doesn't take guests sends them to sign in, unless they've
  // already gone elsewhere (the answer can arrive after they've left). If
  // the server can't be asked, they stay: Transform will say what's wrong.
  private async loadSettings(): Promise<void> {
    let left = false;
    this.destroyRef.onDestroy(() => (left = true));
    try {
      const settings = await this.api.settings();
      this.settings.set(settings);
      if (settings.guests === 'off' && !this.signedIn() && !left) {
        this.router.navigateByUrl('/signin');
      }
    } catch {
      // Keep the defaults: the server filters.
    }
  }

  // ---- photos made as a guest, once signed in ----

  async importPhotos(): Promise<void> {
    if (this.importing()) return;
    this.importing.set(true);
    let added = 0;
    try {
      // Oldest first, so they keep their order.
      for (const photo of [...this.waitingPhotos()].reverse()) {
        try {
          if (!this.roomToKeep()) {
            this.addError(this.fullMessage());
            break;
          }
          const saved = await this.api.import(photo, await this.keepable(photo));
          await this.guestStore.remove(photo);
          this.waitingPhotos.update((list) => list.filter((p) => p !== photo));
          this.photos.update((list) =>
            [saved, ...list].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
          );
          added++;
        } catch (err) {
          this.addError(errorMessage(err, 'Could not add a photo to your account.'));
          break;
        }
      }
    } finally {
      this.importing.set(false);
    }
    refocus(this.injector, ['main']);
    if (added) {
      this.messages.update((list) => [
        ...list,
        'Added ' + added + ' photo' + (added > 1 ? 's' : '') + ' to your account.',
      ]);
    }
  }

  async discardPhotos(): Promise<void> {
    for (const photo of this.waitingPhotos()) await this.guestStore.remove(photo);
    this.waitingPhotos.set([]);
    this.confirmDiscard.set(false);
    refocus(this.injector, ['main']);
  }

  // Asks before deleting the guest's photos, with the focus on Keep; and
  // back to Delete if they're kept.
  askDiscard(asking: boolean): void {
    this.confirmDiscard.set(asking);
    refocus(this.injector, [asking ? '.banner.waiting .keep' : '.banner.waiting .discard'], {
      always: true,
    });
  }

  // ---- layout ----

  // On phones the photo stays at the top of the screen, and everywhere the
  // Transform bar stays at the bottom. Their heights go to the page's scroll
  // padding (styles.scss), so the browser never scrolls a control under them.
  private trackStickyParts(): void {
    if (typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement.style;
    const phone = window.matchMedia?.('(max-width: 859px)');
    const update = () => {
      const stage = this.stage().nativeElement;
      const pinned = !!phone?.matches && stage.classList.contains('has-photo');
      root.setProperty('--sticky-top', pinned ? stage.offsetHeight + 'px' : '0px');
      root.setProperty('--sticky-bottom', this.actionBar().nativeElement.offsetHeight + 'px');
    };
    const observer = new ResizeObserver(update);
    observer.observe(this.stage().nativeElement);
    observer.observe(this.actionBar().nativeElement);
    phone?.addEventListener('change', update);
    this.destroyRef.onDestroy(() => {
      observer.disconnect();
      phone?.removeEventListener('change', update);
      root.removeProperty('--sticky-top');
      root.removeProperty('--sticky-bottom');
    });
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
    this.draftTimer = setTimeout(() => this.flushDraft(), DRAFT_SAVE_MS);
  }

  // Saves the stack now if a save is waiting, e.g. as the page is closed or
  // goes into the background (where a phone may unload it).
  flushDraft(): void {
    if (this.draftTimer === undefined) return;
    clearTimeout(this.draftTimer);
    this.draftTimer = undefined;
    this.drafts.saveStack({ steps: this.history.steps(), index: this.history.index() });
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

  // The button pressed is disabled at the end of the history, and the
  // control the focus was in may be gone: then the other button has it.
  undo(): void {
    const state = this.history.undo();
    if (state) this.show(state);
    this.saveStackDraft();
    refocus(this.injector, ['#undo:enabled', '#redo:enabled', '#filter-0']);
  }

  redo(): void {
    const state = this.history.redo();
    if (state) this.show(state);
    this.saveStackDraft();
    refocus(this.injector, ['#redo:enabled', '#undo:enabled', '#filter-0']);
  }

  goTo(index: number): void {
    const state = this.history.jump(index);
    if (state) this.show(state);
    this.saveStackDraft();
    const menu = this.historyMenu()?.nativeElement;
    if (menu) menu.open = false;
    refocus(this.injector, ['details.history summary'], { always: true });
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
      // From the sample button, say, which has gone.
      refocus(this.injector, ['figure.preview']);
    } catch (err) {
      this.addError(err instanceof PhotoFileError ? err.message : 'Could not read that file.');
    }
  }

  private async useSharedPhoto(): Promise<void> {
    const file = await takeSharedPhoto();
    if (file) await this.usePhoto(file);
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
    refocus(this.injector, ['figure.preview']);
  }

  // Back to the button that opened the camera.
  closeCamera(): void {
    this.cameraOn.set(false);
    refocus(this.injector, ['#camera', '#file']);
  }

  readonly loadingSample = signal(false);

  // A photo to try the filters on, for visitors without one to hand.
  async useSample(): Promise<void> {
    this.loadingSample.set(true);
    try {
      const res = await fetch(SAMPLE_PHOTO.url);
      if (!res.ok) throw new Error(res.statusText);
      const blob = await res.blob();
      await this.usePhoto(new File([blob], SAMPLE_PHOTO.name, { type: 'image/jpeg' }));
    } catch {
      this.addError('Could not load the sample photo.');
    } finally {
      this.loadingSample.set(false);
    }
  }

  clearPhoto(): void {
    this.source.set(null);
    this.sourceName.set('');
    this.savePhotoDraft();
    refocus(this.injector, ['#file']);
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
    // To the filter now in its place (whose own Remove button may be where
    // the focus is: pressing it again would remove that one too).
    refocus(this.injector, ['#filter-' + Math.min(index, this.layers().length - 1)], {
      always: true,
    });
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
    // The focus goes with the layer, to the same button unless that's now
    // disabled (at the top or bottom).
    const moved = '.layers > li:nth-child(' + (to + 1) + ') ';
    const [same, other] = by < 0 ? ['.move-up', '.move-down'] : ['.move-down', '.move-up'];
    refocus(this.injector, [moved + same + ':enabled', moved + other], { always: true });
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
    // Guests have nothing to save a photo to, so there's no point without a
    // filter; nor is there when the device does the filtering.
    if (body.tOption === '' && (!this.signedIn() || this.onDevice())) {
      this.addError('Choose a filter first.');
      return;
    }
    if (this.onDevice()) return this.transformOnDevice(source);
    if (body.tOption === '') {
      this.messages.update((list) => [...list, 'No filter chosen, so the original was saved.']);
    }
    this.transforming.set(true);
    try {
      let photo: Photo;
      if (this.signedIn()) {
        photo = await this.api.transform(body);
      } else {
        // Guests' photos go to the server only up to a smaller size.
        const max = this.settings()?.guestMaxPixels;
        if (max) body.content = await fitPhoto(body.content, max);
        const made = await this.api.preview(body);
        try {
          // Kept as a file (guest-photos.ts).
          const file = await (await fetch(made.content!)).blob();
          photo = await this.guestStore.add({ ...made, content: undefined, file, mime: file.type });
        } catch (err) {
          if (!(err instanceof BrowserStorageError)) throw err;
          // Shown anyway, to save, until the page is left.
          photo = { ...made, _id: LOCAL_ID + Date.now().toString(36) };
          this.addError(
            err.message + ' The photo stays here until you leave the page: Save it to keep it.',
          );
        }
      }
      this.photos.update((photos) => [photo, ...photos]);
      this.latestId.set(photo._id);
      this.announce('Made ' + photoLabel(this.filters(), photo) + '. It is first in your photos.');
    } catch (err) {
      this.addError(errorMessage(err, 'Could not transform the photo.'));
    } finally {
      this.transforming.set(false);
    }
  }

  // Filters the photo at full size on this device's GPU, and offers the
  // result (this.made). Where the browser can't, and the server allows it,
  // the server does it as usual.
  private async transformOnDevice(source: string): Promise<void> {
    this.transforming.set(true);
    this.discardMade();
    const layers = this.layers();
    try {
      const file = await (await fetch(source)).blob();
      const result = await this.deviceTransform.run(
        file,
        stackLayers(layers),
        this.blendModeNames(),
      );
      const photo = madePhoto(transformRequest('', layers));
      const label = photoLabel(this.filters(), { ...photo, _id: '' });
      this.made.set({
        ...result,
        url: URL.createObjectURL(result.file),
        label,
        fileName: downloadName(label, { _id: Date.now().toString(36), mime: result.file.type }),
      });
      this.madeLayers = layers;
    } catch (err) {
      if (!(err instanceof DeviceTransformError)) {
        this.addError('Could not filter the photo on this device.');
      } else if (err.message !== 'Cancelled.') {
        this.addError(
          err.noGpu
            ? "This server filters photos on your own device's GPU, which needs a browser " +
                'with WebGPU or WebGL2, as almost every browser has; it may be turned off in ' +
                "this one's settings."
            : err.message,
        );
      }
    } finally {
      this.transforming.set(false);
    }
  }

  // The stack the photo in this.made was made with.
  private madeLayers: Layer[] = [];

  cancelTransform(): void {
    this.deviceTransform.cancel();
  }

  private fullMessage(): string {
    const limit = this.storageLimit();
    return (
      'You already keep ' +
      limit +
      ' photos, as many as this server allows. Delete one to keep another.'
    );
  }

  // Keeps the photo made on this device: on the server when signed in (it
  // checks the photo, and the limit), otherwise in this browser.
  async keepMade(): Promise<void> {
    const made = this.made();
    if (!made || this.keeping()) return;
    if (!this.roomToKeep()) {
      this.addError(this.fullMessage());
      return;
    }
    this.keeping.set(true);
    try {
      // The server may keep a smaller copy; guests keep theirs as it is.
      const signedIn = this.signedIn();
      const file = signedIn
        ? await fitForKeeping(made.file, this.settings()?.keepMaxSide ?? null)
        : made.file;
      if (signedIn && file.size > MAX_FILE_BYTES) {
        this.addError('This photo is too large to keep on the server. Save it instead.');
        return;
      }
      const photo = madePhoto(transformRequest('', this.madeLayers));
      const kept = signedIn
        ? await this.api.import(photo, file)
        : await this.guestStore.add({
            ...photo,
            file,
            mime: file.type,
            width: made.width,
            height: made.height,
          });
      // The gallery's Save and Share need not fetch it again.
      if (signedIn) this.api.remember(kept._id, file);
      this.photos.update((photos) => [kept, ...photos]);
      this.latestId.set(kept._id);
      this.discardMade();
      this.announce('Kept. It is first in your photos.');
      refocus(this.injector, ['#transform']);
    } catch (err) {
      this.addError(errorMessage(err, 'Could not keep the photo.'));
    } finally {
      this.keeping.set(false);
    }
  }

  // A photo kept in this browser, as a file the way this server keeps it:
  // scaled down here if the server would anyway, so less goes over the
  // network.
  private async keepable(photo: Photo): Promise<Blob> {
    return fitForKeeping(await photoFile(photo), this.settings()?.keepMaxSide ?? null);
  }

  discardMade(): void {
    const made = this.made();
    if (made) URL.revokeObjectURL(made.url);
    this.made.set(null);
  }

  // Discard on the result card.
  onDiscard(): void {
    this.discardMade();
    refocus(this.injector, ['#transform']);
  }

  // Cleared first, so the same words twice are read out twice.
  private announce(text: string): void {
    this.announcement.set('');
    setTimeout(() => this.announcement.set(text), 100);
  }

  async deletePhoto(photo: Photo): Promise<void> {
    // The focus goes to the next photo's buttons, or the one before.
    const photos = this.photos();
    const at = photos.indexOf(photo);
    const near = [photos[at + 1], photos[at - 1]]
      .filter((p) => p)
      .map((p) => '[id="photo-' + p._id + '"] .actions button');
    try {
      if (isLocal(photo)) {
        await this.guestStore.remove(photo);
      } else {
        await this.api.delete(photo);
      }
      this.photos.update((list) => list.filter((p) => p !== photo));
      this.announce('Photo deleted.');
      refocus(this.injector, [...near, '#transform']);
    } catch (err) {
      this.addError(errorMessage(err, 'Could not delete that photo.'));
    }
  }
}

// What went wrong, for the page: the server's message, or the browser's
// when it couldn't keep a photo, or the fallback.
function errorMessage(err: unknown, fallback: string): string {
  return err instanceof BrowserStorageError ? err.message : serverMessage(err, fallback);
}
