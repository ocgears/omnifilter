import { TestBed } from '@angular/core/testing';
import { LivePreview } from './live-preview';
import { stackLayers } from './preview-engine';

describe('LivePreview', () => {
  it('shows the photo as it is, and says why, where there is no WebGPU', async () => {
    const fixture = TestBed.createComponent(LivePreview);
    fixture.componentRef.setInput('source', 'data:image/png;base64,AA==');
    fixture.componentRef.setInput('layers', []);
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(fixture.componentInstance.mode()).toBe('static');
    expect(el.querySelector('#preview')?.hasAttribute('hidden')).toBe(false);
    expect(el.querySelector('canvas')?.hasAttribute('hidden')).toBe(true);
    expect(el.querySelector('.status')?.textContent).toContain('needs a browser with WebGPU');
    expect(el.querySelector('.compare')).toBeNull();
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
