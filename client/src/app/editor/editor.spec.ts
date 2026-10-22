import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FILTERS, PRESETS } from '../../testing/fixtures';
import { Router, provideRouter } from '@angular/router';
import { AuthService } from '../auth.service';
import { GuestPhotos } from '../guest-photos';
import { Photo } from '../models';
import { PhotoApi } from '../photo-api.service';
import { DeviceTransform, DeviceTransformError } from './device-transform';
import { DraftStore } from './draft-store';
import { Editor } from './editor';
import { PreviewEngine } from './preview-engine';

describe('Editor', () => {
  let fixture: ComponentFixture<Editor>;
  let editor: Editor;
  let el: HTMLElement;
  let api: { [K in keyof PhotoApi]: ReturnType<typeof vi.fn> };
  let drafts: { [K in keyof DraftStore]: ReturnType<typeof vi.fn> };
  let guestPhotos: { [K in keyof GuestPhotos]: ReturnType<typeof vi.fn> };
  let token: ReturnType<typeof signal<string | null>>;
  let device: {
    run: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    progress: unknown;
  };

  const SETTINGS = {
    mode: 'standard',
    processing: 'server',
    guests: 'server',
    maxStoredPhotos: null,
    keepMaxSide: null,
    maxPixels: 50e6,
    guestMaxPixels: 16e6,
  };
  const CLOUD = {
    ...SETTINGS,
    mode: 'cloud',
    processing: 'device',
    guests: 'device',
    maxStoredPhotos: 5,
    keepMaxSide: 2048,
  };

  const saved: Photo = { _id: 'p1', content: 'data:image/png;base64,AA==', tOption: 'invert' };

  async function create(): Promise<void> {
    fixture = TestBed.createComponent(Editor);
    editor = fixture.componentInstance;
    el = fixture.nativeElement;
    await fixture.whenStable();
  }

  beforeEach(() => {
    api = {
      filters: vi
        .fn()
        .mockResolvedValue([
          ...FILTERS,
          { name: 'neural', label: 'Neural', group: 'Neural style', params: [], available: false },
        ]),
      presets: vi.fn().mockResolvedValue(PRESETS),
      device: vi.fn().mockResolvedValue({ name: 'Test GPU', type: 'gpu', platform: 'Test' }),
      all: vi.fn().mockResolvedValue({ photos: [saved], total: 1 }),
      transform: vi.fn(),
      delete: vi.fn(),
      settings: vi.fn().mockResolvedValue(SETTINGS),
      preview: vi.fn(),
      import: vi.fn(),
      file: vi.fn(),
      fileIfReady: vi.fn().mockReturnValue(null),
      remember: vi.fn(),
      share: vi.fn(),
      unshare: vi.fn(),
      shareUrl: vi.fn((id: string) => 'http://localhost/p/' + id),
    };
    guestPhotos = {
      list: vi.fn().mockResolvedValue([]),
      add: vi.fn(async (p: Omit<Photo, '_id'>) => ({ ...p, _id: 'local-1' })),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    token = signal<string | null>('tok');
    device = { run: vi.fn(), cancel: vi.fn(), progress: signal(null) };
    drafts = {
      load: vi.fn().mockResolvedValue({ photo: null, stack: null }),
      savePhoto: vi.fn().mockResolvedValue(undefined),
      saveStack: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    TestBed.configureTestingModule({
      imports: [Editor],
      providers: [
        provideRouter([]),
        { provide: PhotoApi, useValue: api },
        { provide: DraftStore, useValue: drafts },
        { provide: GuestPhotos, useValue: guestPhotos },
        { provide: AuthService, useValue: { token } },
        { provide: DeviceTransform, useValue: device },
      ],
    });
  });

  it("loads the filters (hiding ones the server can't run), presets, device and photos", async () => {
    await create();
    expect(editor.filters().map((f) => f.name)).toEqual(['blur', 'invert', 'sepia']);
    expect(editor.maxLayers()).toBe(3);
    expect(editor.blendModes().map((b) => b.value)).toEqual(['normal', 'multiply']);
    expect(el.querySelector('.device-info')?.textContent).toContain('Test GPU (GPU, Test)');
    expect(el.querySelectorAll('.photo-card').length).toBe(1);
    const options = Array.from(el.querySelectorAll('#filter-0 optgroup')).map((g) =>
      g.getAttribute('label'),
    );
    expect(options).toEqual(['Blur', 'Colour']);
  });

  it('loads the gallery a page at a time', async () => {
    const page = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...saved, _id: 'p' + (from + i) }));
    api.all.mockResolvedValueOnce({ photos: page(0, 24), total: 30 });
    await create();
    expect(api.all).toHaveBeenCalledWith(24);
    expect(el.querySelectorAll('.photo-card').length).toBe(24);
    expect(el.querySelector('#gallery-title')?.textContent).toContain('30');
    const more = el.querySelector<HTMLButtonElement>('.more button')!;
    expect(more.textContent).toContain('Show more (6 more)');
    api.all.mockResolvedValueOnce({ photos: page(24, 6), total: 30 });
    more.click();
    await fixture.whenStable();
    expect(api.all.mock.calls[1]).toEqual([24, expect.objectContaining({ _id: 'p23' })]);
    expect(el.querySelectorAll('.photo-card').length).toBe(30);
    expect(el.querySelector('.more')).toBeNull();
  });

  it("shows an error when the photos can't be loaded", async () => {
    api.all.mockRejectedValue(
      new HttpErrorResponse({ status: 401, error: { msg: 'Please sign in again' } }),
    );
    await create();
    expect(el.querySelector('[role=alert]')?.textContent).toContain('Please sign in again');
  });

  it('starts a picked filter from its default settings, and builds its controls', async () => {
    await create();
    editor.setFilter(0, 'sepia');
    await fixture.whenStable();
    expect(editor.layers()[0].params).toEqual({ amount: 80, tone: 'warm' });
    expect(el.querySelectorAll('.layer input[type=range]').length).toBe(2);
    editor.setParam(0, FILTERS[2].params[0], '55');
    expect(editor.layers()[0].params['amount']).toBe(55);
  });

  it("fills in the layers from a preset, and forgets the preset once they're edited", async () => {
    await create();
    const chip = Array.from(el.querySelectorAll<HTMLButtonElement>('.chip')).find(
      (b) => b.textContent?.trim() === 'Soft sepia',
    )!;
    chip.click();
    await fixture.whenStable();
    expect(editor.layers().map((l) => l.tOption)).toEqual(['blur', 'sepia']);
    expect(editor.layers()[1].amount).toBe(50);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('.description')?.textContent).toContain('Blurred, then toned.');

    editor.setAmount(0, '70');
    await fixture.whenStable();
    expect(editor.selectedPreset()).toBeNull();
    expect(chip.getAttribute('aria-pressed')).toBe('false');
  });

  it("turns down presets that use filters the server can't run", async () => {
    await create();
    const chip = Array.from(el.querySelectorAll<HTMLButtonElement>('.chip')).find(
      (b) => b.textContent?.trim() === 'Dream',
    )!;
    expect(chip.disabled).toBe(true);
    editor.applyPreset(PRESETS.presets[1]);
    expect(editor.selectedPreset()).toBeNull();
    expect(editor.errors()[0]).toContain('not_here');
  });

  it("keeps a preset's settings when the filter list hasn't loaded yet", async () => {
    let finish!: (f: unknown) => void;
    api.filters.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await create();
    editor.applyPreset(PRESETS.presets[0]);
    expect(editor.layers()[0].params).toEqual({ radius: 9 });
    finish(FILTERS);
    await fixture.whenStable();
    expect(editor.layers()[1].params).toEqual({ amount: 80, tone: 'warm' });
    expect(editor.selectedPreset()).toBe('soft');
  });

  it('reorders, removes and limits layers', async () => {
    await create();
    editor.setFilter(0, 'blur');
    editor.addLayer();
    editor.setFilter(1, 'invert');
    editor.addLayer();
    editor.addLayer();
    expect(editor.layers().length).toBe(3);
    editor.moveLayer(1, -1);
    expect(editor.layers().map((l) => l.tOption)).toEqual(['invert', 'blur', null]);
    editor.moveLayer(0, -1);
    expect(editor.layers()[0].tOption).toBe('invert');
    editor.removeLayer(0);
    editor.removeLayer(0);
    editor.removeLayer(0);
    expect(editor.layers()).toEqual([{ tOption: null, params: {}, amount: 100, blend: 'normal' }]);
  });

  it("can't transform until a photo is picked", async () => {
    await create();
    const button = el.querySelector<HTMLButtonElement>('#transform')!;
    expect(button.disabled).toBe(true);
    await editor.transform();
    expect(api.transform).not.toHaveBeenCalled();
    expect(editor.errors()).toEqual(['Choose a photo first.']);
  });

  it('transforms the photo and puts the result first', async () => {
    await create();
    const made: Photo = { _id: 'p2', content: 'data:image/jpeg;base64,AA==', tOption: 'blur' };
    api.transform.mockResolvedValue(made);
    editor.source.set('data:image/png;base64,BB==');
    editor.setFilter(0, 'blur');
    await fixture.whenStable();
    el.querySelector<HTMLButtonElement>('#transform')!.click();
    await fixture.whenStable();
    expect(api.transform).toHaveBeenCalledWith({
      content: 'data:image/png;base64,BB==',
      tOption: 'blur',
      params: { radius: 3 },
    });
    expect(editor.photos().map((p) => p._id)).toEqual(['p2', 'p1']);
    expect(editor.latestId()).toBe('p2');
    expect(editor.transforming()).toBe(false);
  });

  it("shows the server's message when a transform fails", async () => {
    await create();
    api.transform.mockRejectedValue(
      new HttpErrorResponse({ status: 503, error: { msg: 'The server is busy' } }),
    );
    editor.source.set('data:image/png;base64,BB==');
    await editor.transform();
    expect(editor.errors()).toEqual(['The server is busy']);
    expect(editor.photos().length).toBe(1);
  });

  it('deletes a photo', async () => {
    await create();
    api.delete.mockResolvedValue({ msg: 'Successfully deleted content' });
    await editor.deletePhoto(editor.photos()[0]);
    expect(api.delete).toHaveBeenCalledWith(saved);
    expect(editor.photos()).toEqual([]);
    // Said to screen readers only: the card going is plain to see.
    expect(editor.messages()).toEqual([]);
    await vi.waitFor(() => expect(editor.announcement()).toBe('Photo deleted.'));
  });

  it("refuses a file that isn't an image", async () => {
    await create();
    await editor.usePhoto(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    expect(editor.source()).toBeNull();
    expect(editor.errors()).toEqual(["That isn't an image file."]);
  });

  describe('undo and history', () => {
    const labels = () => editor.history.steps().map((s) => s.label);
    const press = (key: string, extra: KeyboardEventInit = {}) =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, ...extra }));

    it('undoes and redoes edits from the buttons and the keyboard', async () => {
      await create();
      editor.setFilter(0, 'sepia');
      editor.setParam(0, FILTERS[2].params[1], 'cool');
      editor.addLayer();
      expect(labels()).toEqual(['Start', 'Layer 1: Sepia', 'Sepia: Tone Cool', 'Added a layer']);
      await fixture.whenStable();

      el.querySelector<HTMLButtonElement>('#undo')!.click();
      expect(editor.layers().length).toBe(1);
      press('z');
      expect(editor.layers()[0].params['tone']).toBe('warm');
      press('z', { shiftKey: true });
      expect(editor.layers()[0].params['tone']).toBe('cool');
      press('y');
      expect(editor.layers().length).toBe(2);
      await fixture.whenStable();
      expect(el.querySelector<HTMLButtonElement>('#redo')!.disabled).toBe(true);
      expect(el.querySelector('#undo')!.getAttribute('aria-label')).toBe('Undo Added a layer');
    });

    it('records a slider when it is let go, not while it moves', async () => {
      await create();
      editor.setFilter(0, 'blur');
      const radius = FILTERS[0].params[0];
      editor.setParam(0, radius, '5', false);
      editor.setParam(0, radius, '8', false);
      expect(editor.layers()[0].params['radius']).toBe(8);
      expect(labels()).toEqual(['Start', 'Layer 1: Gaussian blur']);
      editor.setParam(0, radius, '9');
      editor.setAmount(0, '40');
      expect(labels()).toEqual([
        'Start',
        'Layer 1: Gaussian blur',
        'Gaussian blur: Radius 9',
        'Gaussian blur: strength 40%',
      ]);
      editor.undo();
      editor.undo();
      expect(editor.layers()[0].params['radius']).toBe(3);
    });

    it('puts back a preset look, and goes to any step from the list', async () => {
      await create();
      editor.applyPreset(PRESETS.presets[0]);
      editor.removeLayer(0);
      expect(editor.selectedPreset()).toBeNull();
      editor.undo();
      expect(editor.selectedPreset()).toBe('soft');
      await fixture.whenStable();

      const menu = el.querySelector<HTMLDetailsElement>('details.history')!;
      menu.open = true;
      const steps = Array.from(menu.querySelectorAll<HTMLButtonElement>('.steps button'));
      expect(steps.map((b) => b.textContent?.trim())).toEqual([
        'Start',
        'Soft sepia look',
        'Removed Gaussian blur',
      ]);
      expect(steps[1].getAttribute('aria-current')).toBe('step');
      expect(steps[2].classList).toContain('undone');
      steps[0].click();
      expect(editor.layers().map((l) => l.tOption)).toEqual([null]);
      expect(menu.open).toBe(false);
    });

    it('leaves Ctrl+Z to text boxes', async () => {
      await create();
      editor.addLayer();
      const box = document.createElement('input');
      document.body.appendChild(box);
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
      box.remove();
      expect(editor.layers().length).toBe(2);
    });

    it("uses a saved photo's settings, which can be undone", async () => {
      await create();
      editor.setFilter(0, 'invert');
      editor.useSettings({
        _id: 'p3',
        content: '',
        tStack: [{ tOption: 'blur', tParams: { radius: 6 }, amount: 50, blend: 'multiply' }],
      });
      expect(editor.layers()).toEqual([
        { tOption: 'blur', params: { radius: 6 }, amount: 50, blend: 'multiply' },
      ]);
      expect(editor.messages()[0]).toContain('Using the settings from that photo');
      editor.undo();
      expect(editor.layers()[0].tOption).toBe('invert');
    });
  });

  describe('the draft', () => {
    const step = (label: string, tOption: string | null, params = {}) => ({
      label,
      at: 0,
      state: { layers: [{ tOption, params, amount: 100, blend: 'normal' }], preset: null },
    });

    it('comes back after a reload, with its history', async () => {
      drafts.load.mockResolvedValue({
        photo: { source: 'data:image/png;base64,CC==', name: 'cat.png' },
        stack: { steps: [step('Start', null), step('Layer 1: Sepia', 'sepia')], index: 1 },
      });
      await create();
      expect(editor.source()).toBe('data:image/png;base64,CC==');
      expect(editor.sourceName()).toBe('cat.png');
      // Filled in with the filter's defaults once the list arrived.
      expect(editor.layers()[0]).toEqual({
        tOption: 'sepia',
        params: { amount: 80, tone: 'warm' },
        amount: 100,
        blend: 'normal',
      });
      editor.undo();
      expect(editor.layers()[0].tOption).toBeNull();
    });

    it("takes out filters this server doesn't have", async () => {
      drafts.load.mockResolvedValue({
        photo: null,
        stack: { steps: [step('Start', 'retired_filter')], index: 0 },
      });
      await create();
      expect(editor.layers()[0].tOption).toBeNull();
      expect(editor.errors()[0]).toContain("can't run retired_filter");
    });

    it("doesn't replace a photo picked before it arrived", async () => {
      let finish!: (d: unknown) => void;
      drafts.load.mockReturnValue(new Promise((resolve) => (finish = resolve)));
      await create();
      editor.useCapture('data:image/jpeg;base64,DD==');
      finish({ photo: { source: 'data:old', name: 'old.png' }, stack: null });
      await fixture.whenStable();
      expect(editor.source()).toBe('data:image/jpeg;base64,DD==');
      expect(drafts.savePhoto).toHaveBeenCalledWith({
        source: 'data:image/jpeg;base64,DD==',
        name: 'Camera photo',
      });
    });

    it('saves straight away when the page is hidden', async () => {
      await create();
      editor.addLayer();
      window.dispatchEvent(new Event('pagehide'));
      expect(drafts.saveStack).toHaveBeenCalledTimes(1);
      // Nothing more to save.
      window.dispatchEvent(new Event('pagehide'));
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(drafts.saveStack).toHaveBeenCalledTimes(1);
    });

    it('saves the stack shortly after each edit', async () => {
      await create();
      editor.setFilter(0, 'invert');
      editor.addLayer();
      expect(drafts.saveStack).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(drafts.saveStack).toHaveBeenCalledTimes(1);
      const saved = drafts.saveStack.mock.calls[0][0];
      expect(saved.index).toBe(2);
      expect(saved.steps.map((s: { label: string }) => s.label)).toEqual([
        'Start',
        'Layer 1: Invert',
        'Added a layer',
      ]);
    });
  });

  describe('as a guest', () => {
    beforeEach(() => {
      token.set(null);
      // No size limit, so photos aren't scaled (jsdom can't decode images).
      api.settings.mockResolvedValue({ ...SETTINGS, guestMaxPixels: 0 });
    });

    it('shows the photos kept in this browser, and says how to keep them', async () => {
      guestPhotos.list.mockResolvedValue([{ ...saved, _id: 'local-9' }]);
      await create();
      expect(api.all).not.toHaveBeenCalled();
      expect(editor.photos().map((p) => p._id)).toEqual(['local-9']);
      expect(el.querySelector('.banner.guest')?.textContent).toContain(
        'trying OmniFilter as a guest',
      );
      expect(el.querySelector('.banner.guest a[href$="/signup"]')).not.toBeNull();
    });

    it('filters on the server without saving, and keeps the result here', async () => {
      await create();
      api.preview.mockResolvedValue({ content: 'data:image/jpeg;base64,EE==', tOption: 'invert' });
      editor.source.set('data:image/png;base64,BB==');
      editor.setFilter(0, 'invert');
      await editor.transform();
      expect(api.transform).not.toHaveBeenCalled();
      expect(api.preview).toHaveBeenCalledWith({
        content: 'data:image/png;base64,BB==',
        tOption: 'invert',
        params: {},
      });
      expect(guestPhotos.add).toHaveBeenCalled();
      expect(editor.photos()[0]._id).toBe('local-1');

      await editor.deletePhoto(editor.photos()[0]);
      expect(guestPhotos.remove).toHaveBeenCalled();
      expect(api.delete).not.toHaveBeenCalled();
    });

    it('needs a filter to transform', async () => {
      await create();
      editor.source.set('data:image/png;base64,BB==');
      await editor.transform();
      expect(api.preview).not.toHaveBeenCalled();
      expect(editor.errors()).toEqual(['Choose a filter first.']);
    });

    it("stays when the server can't be asked, or the answer comes after leaving", async () => {
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
      api.settings.mockRejectedValue(new HttpErrorResponse({ status: 0 }));
      await create();
      let answer!: (s: unknown) => void;
      api.settings.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      const second = TestBed.createComponent(Editor);
      second.destroy();
      answer({ ...SETTINGS, guests: 'off' });
      await fixture.whenStable();
      expect(navigate).not.toHaveBeenCalled();
    });

    it("goes to sign in when the server doesn't take guests", async () => {
      api.settings.mockResolvedValue({ ...SETTINGS, guests: 'off' });
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
      await create();
      expect(navigate).toHaveBeenCalledWith('/signin');
    });
  });

  describe('photos made as a guest, once signed in', () => {
    const older = { ...saved, _id: 'local-a', createdAt: '2026-10-01T00:00:00.000Z' };
    const newer = { ...saved, _id: 'local-b', createdAt: '2026-10-02T00:00:00.000Z' };

    it('adds them to the account, oldest first', async () => {
      guestPhotos.list.mockResolvedValue([newer, older]);
      api.import.mockImplementation(async (p: Photo) => ({ ...p, _id: 'saved-' + p._id }));
      await create();
      expect(el.querySelector('.banner.waiting')?.textContent).toContain('2 photos');
      await editor.importPhotos();
      expect(api.import.mock.calls.map((c) => c[0]._id)).toEqual(['local-a', 'local-b']);
      expect(guestPhotos.remove).toHaveBeenCalledTimes(2);
      expect(editor.waitingPhotos()).toEqual([]);
      expect(editor.photos().map((p) => p._id)).toEqual(['saved-local-b', 'saved-local-a', 'p1']);
      expect(editor.messages()).toEqual(['Added 2 photos to your account.']);
      await fixture.whenStable();
      expect(el.querySelector('.banner.waiting')).toBeNull();
    });

    it('stops at a failure and keeps the rest', async () => {
      guestPhotos.list.mockResolvedValue([newer, older]);
      api.import.mockRejectedValue(
        new HttpErrorResponse({ status: 413, error: { msg: 'The photo is too large to save' } }),
      );
      await create();
      await editor.importPhotos();
      expect(api.import).toHaveBeenCalledTimes(1);
      expect(editor.waitingPhotos().length).toBe(2);
      expect(editor.errors()).toEqual(['The photo is too large to save']);
    });

    it('deletes them after asking', async () => {
      guestPhotos.list.mockResolvedValue([older]);
      await create();
      const banner = () => el.querySelector('.banner.waiting');
      Array.from(banner()!.querySelectorAll('button'))
        .find((b) => b.textContent?.trim() === 'Delete')!
        .click();
      await fixture.whenStable();
      expect(banner()?.textContent).toContain("can't be undone");
      banner()!.querySelector<HTMLButtonElement>('button.danger')!.click();
      await fixture.whenStable();
      expect(guestPhotos.remove).toHaveBeenCalledWith(older);
      expect(banner()).toBeNull();
    });
  });

  describe('filtering on this device (the hosted demo)', () => {
    const made = {
      file: new Blob(['jpeg'], { type: 'image/jpeg' }),
      width: 4000,
      height: 3000,
      ranAt: null,
      device: 'Test GPU',
      timings: { decode: 300, upload: 50, filters: 1100, readback: 60, encode: 400, total: 1910 },
    };

    // jsdom has no GPU: these fake a browser with one, whose engine starts.
    let supported: ReturnType<typeof vi.spyOn>;
    let engine: { get: ReturnType<typeof vi.fn> };
    beforeEach(() => {
      api.settings.mockResolvedValue(CLOUD);
      URL.createObjectURL = vi.fn(() => 'blob:made');
      URL.revokeObjectURL = vi.fn();
      supported = vi.spyOn(DeviceTransform, 'supported').mockReturnValue(true);
      engine = { get: vi.fn().mockResolvedValue({}) };
      TestBed.overrideProvider(PreviewEngine, { useValue: engine });
    });
    afterEach(() => supported.mockRestore());

    it('filters on this device, and keeps the result only when asked', async () => {
      device.run.mockResolvedValue(made);
      api.import.mockImplementation(async (p: Omit<Photo, '_id'>) => ({ ...p, _id: 'kept' }));
      await create();
      expect(el.querySelector('.device-info')?.textContent).toContain(
        "Filters run at full size on this device's own GPU",
      );
      editor.source.set('data:image/png;base64,BB==');
      editor.setFilter(0, 'invert');
      await editor.transform();
      expect(api.transform).not.toHaveBeenCalled();
      expect(device.run.mock.calls[0][1]).toEqual([
        { tOption: 'invert', params: {}, amount: 100, blend: 'normal' },
      ]);
      // The card's code loads when it's first shown.
      for (let n = 0; n < 5 && !el.querySelector('of-result-card'); n++) {
        await new Promise((resolve) => setTimeout(resolve));
        await fixture.whenStable();
      }
      const card = el.querySelector('of-result-card')!;
      expect(card.textContent).toContain('12.0 MP, made on Test GPU in 1.9 s (6.3 MP/s)');
      expect(card.textContent).toContain('Keep in gallery (2 of 5)');
      expect(card.textContent).toContain('keeps a copy 2048 pixels on its longer side');
      expect(el.querySelector('#gallery-title')?.textContent).toContain('1 of 5 kept');

      await editor.keepMade();
      expect(api.import).toHaveBeenCalledTimes(1);
      // The file itself goes to the server.
      expect(api.import.mock.calls[0][0]).toMatchObject({ tOption: 'invert' });
      expect(api.import.mock.calls[0][1]).toBe(made.file);
      expect(editor.photos().map((p) => p._id)).toEqual(['kept', 'p1']);
      // Ready for the gallery's Save and Share.
      expect(api.remember).toHaveBeenCalledWith('kept', made.file);
      expect(editor.made()).toBeNull();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:made');
    });

    it('keeps no more than the server allows', async () => {
      api.all.mockResolvedValue({
        photos: [1, 2, 3, 4, 5].map((n) => ({ ...saved, _id: 'p' + n })),
        total: 5,
      });
      device.run.mockResolvedValue(made);
      await create();
      editor.source.set('data:image/png;base64,BB==');
      editor.setFilter(0, 'invert');
      await editor.transform();
      expect(editor.keepText()).toBe('Gallery full (5 of 5)');
      await editor.keepMade();
      expect(api.import).not.toHaveBeenCalled();
      expect(editor.errors()[0]).toContain('already keep 5 photos');
    });

    it("keeps a guest's result in this browser", async () => {
      token.set(null);
      device.run.mockResolvedValue(made);
      await create();
      editor.source.set('data:image/png;base64,BB==');
      editor.setFilter(0, 'invert');
      await editor.transform();
      expect(editor.keepText()).toBe('Keep in this browser (1 of 5)');
      await editor.keepMade();
      expect(guestPhotos.add.mock.calls[0][0]).toMatchObject({
        file: made.file,
        mime: 'image/jpeg',
        width: 4000,
        tOption: 'invert',
      });
      expect(api.import).not.toHaveBeenCalled();
      expect(editor.photos()[0]._id).toBe('local-1');
    });

    it("says what's needed when the browser has the APIs but its GPU won't start", async () => {
      engine.get.mockResolvedValue(null);
      await create();
      // Checked once the page is idle.
      await vi.waitFor(() => expect(editor.deviceSupported()).toBe(false));
      await fixture.whenStable();
      expect(el.querySelector('.device-info')?.textContent).toContain(
        'needs a browser with WebGPU',
      );
      editor.source.set('data:image/png;base64,BB==');
      editor.setFilter(0, 'invert');
      await editor.transform();
      expect(device.run).not.toHaveBeenCalled();
      expect(editor.errors()[0]).toContain('needs a browser with WebGPU');
    });

    it('says what browser is needed without WebGPU, and nothing when cancelled', async () => {
      await create();
      editor.source.set('data:image/png;base64,BB==');
      editor.setFilter(0, 'invert');
      device.run.mockRejectedValue(new DeviceTransformError('no GPU here', true));
      await editor.transform();
      expect(editor.errors()[0]).toContain('needs a browser with WebGPU');
      editor.errors.set([]);
      device.run.mockRejectedValue(new DeviceTransformError('Cancelled.'));
      await editor.transform();
      expect(editor.errors()).toEqual([]);
      expect(editor.made()).toBeNull();
    });
  });
});
