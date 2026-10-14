import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FILTERS, PRESETS } from '../../testing/fixtures';
import { Photo } from '../models';
import { PhotoApi } from '../photo-api.service';
import { Editor } from './editor';

describe('Editor', () => {
  let fixture: ComponentFixture<Editor>;
  let editor: Editor;
  let el: HTMLElement;
  let api: { [K in keyof PhotoApi]: ReturnType<typeof vi.fn> };

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
      all: vi.fn().mockResolvedValue([saved]),
      transform: vi.fn(),
      delete: vi.fn(),
    };
    TestBed.configureTestingModule({
      imports: [Editor],
      providers: [{ provide: PhotoApi, useValue: api }],
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
    expect(editor.messages()).toEqual(['Successfully deleted content']);
  });

  it("refuses a file that isn't an image", async () => {
    await create();
    await editor.usePhoto(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    expect(editor.source()).toBeNull();
    expect(editor.errors()).toEqual(["That isn't an image file."]);
  });
});
