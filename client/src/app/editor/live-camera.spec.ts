import { TestBed } from '@angular/core/testing';
import { LiveCamera } from './live-camera';
import { PreviewEngine } from './preview-engine';

describe('LiveCamera', () => {
  it('explains when there is no WebGPU, and can be closed', async () => {
    TestBed.configureTestingModule({
      imports: [LiveCamera],
      providers: [{ provide: PreviewEngine, useValue: { get: async () => null } }],
    });
    const fixture = TestBed.createComponent(LiveCamera);
    fixture.componentRef.setInput('layers', []);
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(fixture.componentInstance.state()).toBe('failed');
    expect(el.querySelector('.message')?.textContent).toContain('need a browser with WebGPU');
    expect(el.querySelector<HTMLButtonElement>('.shutter')!.disabled).toBe(true);
    el.querySelector<HTMLButtonElement>('.controls button')!.click();
    expect(closed).toBe(1);
  });
});
