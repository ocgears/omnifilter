import { TestBed } from '@angular/core/testing';
import type { Animation, PauseReason, Touch } from '../../gpu';
import { AnimationView } from './animation-view';

describe('AnimationView', () => {
  async function settle(fixture: { whenStable(): Promise<unknown> }): Promise<void> {
    for (let n = 0; n < 5; n++) {
      await new Promise((resolve) => setTimeout(resolve));
      await fixture.whenStable();
    }
  }

  function create() {
    const fixture = TestBed.createComponent(AnimationView);
    fixture.componentRef.setInput('source', 'data:image/png;base64,AA==');
    fixture.componentRef.setInput('animation', () => ({}) as Animation);
    return fixture;
  }

  // Stands in for the animator once the view has given up on the GPU.
  function fakeAnimator(view: AnimationView) {
    const reasons = new Set<PauseReason>();
    const animator = {
      touches: [] as Touch[],
      pauseReasons: reasons,
      pause: vi.fn((r: PauseReason, on = true) => (on ? reasons.add(r) : reasons.delete(r))),
      touch: (t: Touch) => animator.touches.push(t),
      reset: vi.fn(async () => {}),
      destroy: vi.fn(),
    };
    (view as unknown as { animator: unknown }).animator = animator;
    view.mode.set('live');
    return animator;
  }

  it('shows the photo as it is, and says why, where there is no GPU engine', async () => {
    const fixture = create();
    await settle(fixture);
    const el: HTMLElement = fixture.nativeElement;
    expect(fixture.componentInstance.mode()).toBe('static');
    expect(el.querySelector('img')).not.toBeNull();
    expect(el.querySelector('canvas')?.hasAttribute('hidden')).toBe(true);
    expect(el.querySelector('.status')?.textContent).toContain('need a browser with WebGPU');
    expect(el.querySelector('.play')).toBeNull();
  });

  it('turns a drag into touches measured on the letterboxed picture', async () => {
    const fixture = create();
    await settle(fixture);
    const view = fixture.componentInstance;
    const animator = fakeAnimator(view);
    fixture.detectChanges();
    const canvas: HTMLCanvasElement = fixture.nativeElement.querySelector('canvas');
    // A 200 x 100 picture in a 400 x 400 box: 400 x 200, 100 px down.
    canvas.width = 200;
    canvas.height = 100;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 }) as DOMRect;
    const at = (x: number, y: number) =>
      ({ clientX: x, clientY: y, pointerId: 1, currentTarget: canvas }) as unknown as PointerEvent;

    view.pointerMove(at(200, 200));
    expect(animator.touches).toEqual([]);
    view.pointerDown(at(200, 200));
    view.pointerMove(at(100, 150));
    view.pointerMove(at(100, 50)); // above the picture
    view.pointerUp();
    view.pointerMove(at(300, 250));
    expect(animator.touches.map((t) => [t.x, t.y])).toEqual([
      [0.5, 0.5],
      [0.25, 0.25],
    ]);
  });

  it('plays and pauses, and pauses while a full-size photo is made', async () => {
    const fixture = create();
    await settle(fixture);
    const view = fixture.componentInstance;
    const animator = fakeAnimator(view);
    view.toggle();
    expect(animator.pauseReasons.has('user')).toBe(true);
    expect(view.playing()).toBe(false);
    view.toggle();
    expect(view.playing()).toBe(true);

    fixture.componentRef.setInput('paused', true);
    await fixture.whenStable();
    expect(animator.pause).toHaveBeenLastCalledWith('job', true);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.status')?.textContent).toContain('Paused while the full-size');
    expect(el.querySelector<HTMLButtonElement>('.play')?.disabled).toBe(true);

    view.reset();
    expect(animator.reset).toHaveBeenCalled();
    fixture.destroy();
    expect(animator.destroy).toHaveBeenCalled();
  });
});
