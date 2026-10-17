import { TestBed } from '@angular/core/testing';
import { LivePreview } from './live-preview';
import { stackLayers } from './preview-engine';

describe('LivePreview', () => {
  // Until the preview has asked for the GPU engine (its code loads on
  // demand) and been told there's none.
  async function settle(fixture: { whenStable(): Promise<unknown> }): Promise<void> {
    for (let n = 0; n < 5; n++) {
      await new Promise((resolve) => setTimeout(resolve));
      await fixture.whenStable();
    }
  }

  it('shows the photo as it is, and says why, where there is no WebGPU', async () => {
    const fixture = TestBed.createComponent(LivePreview);
    fixture.componentRef.setInput('source', 'data:image/png;base64,AA==');
    fixture.componentRef.setInput('layers', []);
    await settle(fixture);
    const el: HTMLElement = fixture.nativeElement;
    expect(fixture.componentInstance.mode()).toBe('static');
    expect(el.querySelector('#preview')?.hasAttribute('hidden')).toBe(false);
    expect(el.querySelector('canvas')?.hasAttribute('hidden')).toBe(true);
    expect(el.querySelector('.status')?.textContent).toContain('needs a browser with WebGPU');
    expect(el.querySelector('.compare')).toBeNull();
  });

  it('says so, and lets go of its cached images, while a full-size photo is made', async () => {
    const fixture = TestBed.createComponent(LivePreview);
    fixture.componentRef.setInput('source', 'data:image/png;base64,AA==');
    fixture.componentRef.setInput('layers', []);
    await settle(fixture);
    const preview = fixture.componentInstance;
    const clearCache = vi.fn();
    (preview as unknown as { renderer: unknown }).renderer = { clearCache, destroy: () => {} };
    preview.mode.set('live');
    preview.comparing.set(true);
    fixture.componentRef.setInput('paused', true);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.status')?.textContent).toContain('Live preview paused');
    expect(el.querySelector<HTMLButtonElement>('.compare')?.disabled).toBe(true);
    expect(preview.comparing()).toBe(false);
    expect(clearCache).toHaveBeenCalled();

    fixture.componentRef.setInput('paused', false);
    await fixture.whenStable();
    expect(el.querySelector('.status')?.textContent).toContain('Live preview');
    expect(el.querySelector('.status')?.textContent).not.toContain('paused');
    expect(el.querySelector<HTMLButtonElement>('.compare')?.disabled).toBe(false);
  });

  it('passes on only the layers with a filter', () => {
    expect(
      stackLayers([
        { tOption: null, params: {}, amount: 100, blend: 'normal' },
        { tOption: 'invert', params: { amount: 50 }, amount: 70, blend: 'screen' },
      ]),
    ).toEqual([{ tOption: 'invert', params: { amount: 50 }, amount: 70, blend: 'screen' }]);
  });
});
