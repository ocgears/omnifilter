import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FILTERS } from '../../testing/fixtures';
import { Photo } from '../models';
import { Gallery, downloadName } from './gallery';

describe('Gallery', () => {
  const photo: Photo = {
    _id: '65f0c0ffee00000000abcdef',
    content: 'data:image/jpeg;base64,AA==',
    tStack: [{ tOption: 'sepia' }, { tOption: 'blur' }],
    createdAt: '2026-10-13T12:00:00.000Z',
  };
  let fixture: ComponentFixture<Gallery>;
  let el: HTMLElement;

  beforeEach(async () => {
    fixture = TestBed.createComponent(Gallery);
    fixture.componentRef.setInput('photos', [photo]);
    fixture.componentRef.setInput('filters', FILTERS);
    el = fixture.nativeElement;
    await fixture.whenStable();
  });

  it('names downloads after the filters, with the right extension', () => {
    expect(downloadName('Sepia + Gaussian blur', photo)).toBe(
      'omnifilter-sepia-gaussian-blur-abcdef.jpg',
    );
    expect(downloadName('', { _id: '1', content: 'data:image/webp;base64,AA==' })).toBe(
      'omnifilter-photo-1.webp',
    );
  });

  it('shows each photo with what was applied and a way to save it', () => {
    const card = el.querySelector('.photo-card')!;
    expect(card.querySelector('.label')?.textContent).toBe('Sepia + Gaussian blur');
    expect(card.querySelector('img')?.getAttribute('alt')).toBe('Sepia + Gaussian blur');
    const save = card.querySelector('a[download]')!;
    expect(save.getAttribute('download')).toBe('omnifilter-sepia-gaussian-blur-abcdef.jpg');
    expect(save.getAttribute('href')).toBe(photo.content);
  });

  it('asks before deleting', async () => {
    const removed: Photo[] = [];
    fixture.componentInstance.remove.subscribe((p) => removed.push(p));
    const buttons = () => Array.from(el.querySelectorAll<HTMLButtonElement>('.actions button'));
    buttons()
      .find((b) => b.textContent?.trim() === 'Delete')!
      .click();
    await fixture.whenStable();
    expect(el.textContent).toContain('Delete this photo?');
    buttons()
      .find((b) => b.textContent?.trim() === 'Keep')!
      .click();
    await fixture.whenStable();
    expect(removed).toEqual([]);

    buttons()
      .find((b) => b.textContent?.trim() === 'Delete')!
      .click();
    await fixture.whenStable();
    buttons()
      .find((b) => b.textContent?.trim() === 'Delete')!
      .click();
    expect(removed).toEqual([photo]);
  });
});
