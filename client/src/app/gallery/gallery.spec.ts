import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FILTERS } from '../../testing/fixtures';
import { Photo } from '../models';
import { PhotoApi } from '../photo-api.service';
import { downloadName } from '../photo-names';
import { Gallery } from './gallery';

describe('Gallery', () => {
  const photo: Photo = {
    _id: '65f0c0ffee00000000abcdef',
    thumb: 'data:image/webp;base64,VGg=',
    mime: 'image/jpeg',
    width: 4000,
    height: 3000,
    tStack: [{ tOption: 'sepia' }, { tOption: 'blur' }],
    createdAt: '2026-10-13T12:00:00.000Z',
  };
  let fixture: ComponentFixture<Gallery>;
  let el: HTMLElement;
  let api: { file: ReturnType<typeof vi.fn>; fileIfReady: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    api = {
      file: vi.fn().mockResolvedValue(new Blob(['jpeg'], { type: 'image/jpeg' })),
      fileIfReady: vi.fn().mockReturnValue(null),
    };
    TestBed.configureTestingModule({ providers: [{ provide: PhotoApi, useValue: api }] });
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

  it("shows each photo's thumbnail with what was applied, and saves the photo itself", async () => {
    const card = el.querySelector('.photo-card')!;
    expect(card.querySelector('.label')?.textContent).toBe('Sepia + Gaussian blur');
    const img = card.querySelector('img')!;
    expect(img.getAttribute('alt')).toBe('Sepia + Gaussian blur');
    expect(img.getAttribute('src')).toBe(photo.thumb);
    URL.createObjectURL = vi.fn(() => 'blob:photo');
    URL.revokeObjectURL = vi.fn();
    const clicked: HTMLAnchorElement[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    const save = Array.from(card.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Save',
    )!;
    expect(save.title).toBe('Save the photo, 4000×3000');
    await fixture.componentInstance.save(photo);
    expect(api.file).toHaveBeenCalledWith(photo);
    expect(clicked.map((a) => [a.href, a.download])).toEqual([
      ['blob:photo', 'omnifilter-sepia-gaussian-blur-abcdef.jpg'],
    ]);
    click.mockRestore();
  });

  it('shows a photo kept in this browser from its data URL when it has no thumbnail', async () => {
    const local: Photo = {
      _id: 'local-1',
      content: 'data:image/png;base64,AA==',
      tOption: 'invert',
    };
    fixture.componentRef.setInput('photos', [local]);
    await fixture.whenStable();
    expect(el.querySelector('img')?.getAttribute('src')).toBe(local.content);
  });

  it('asks for a second tap to share a photo that had to be fetched first', async () => {
    const share = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('no'), { name: 'NotAllowedError' }));
    Object.assign(navigator, { share, canShare: () => true });
    await fixture.componentInstance.share(photo);
    expect(api.file).toHaveBeenCalled();
    expect(fixture.componentInstance.shareError()).toContain('tap Share again');
    // Now it's to hand, and shared straight away.
    api.fileIfReady.mockReturnValue(new Blob(['jpeg'], { type: 'image/jpeg' }));
    share.mockResolvedValue(undefined);
    api.file.mockClear();
    await fixture.componentInstance.share(photo);
    expect(api.file).not.toHaveBeenCalled();
    expect(share).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Sepia + Gaussian blur' }),
    );
    expect(fixture.componentInstance.shareError()).toBeNull();
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

  it('offers the settings a photo was made with, but not for an unfiltered one', async () => {
    const reused: Photo[] = [];
    fixture.componentInstance.reuse.subscribe((p) => reused.push(p));
    const plain: Photo = { _id: 'plain', content: 'data:image/png;base64,AA==', tOption: '' };
    fixture.componentRef.setInput('photos', [photo, plain]);
    await fixture.whenStable();
    const [first, second] = Array.from(el.querySelectorAll('.photo-card'));
    const use = (card: Element) =>
      Array.from(card.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Use settings',
      );
    use(first)!.click();
    expect(reused).toEqual([photo]);
    expect(use(second)).toBeUndefined();
  });
});
