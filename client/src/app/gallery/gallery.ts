import { DatePipe } from '@angular/common';
import { Component, ElementRef, effect, inject, input, output, signal } from '@angular/core';
import { Filter, Photo } from '../models';
import { photoLabel } from '../editor/stack';

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/tiff': 'tif',
};

// A file name for saving a photo, like omnifilter-sepia-vignette-1a2b3c.jpg.
export function downloadName(label: string, photo: Photo): string {
  const type = /^data:([^;,]+)/.exec(photo.content)?.[1] ?? '';
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return (
    'omnifilter-' +
    (slug || 'photo') +
    '-' +
    photo._id.slice(-6) +
    '.' +
    (EXTENSIONS[type] ?? 'img')
  );
}

// The user's saved photos, newest first, to save, share or delete.
@Component({
  selector: 'of-gallery',
  imports: [DatePipe],
  templateUrl: './gallery.html',
  styleUrl: './gallery.scss',
})
export class Gallery {
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly photos = input.required<Photo[]>();
  readonly filters = input.required<Filter[]>();
  // A photo to scroll to and point out, such as the one just made.
  readonly highlight = input<string | null>(null);
  // How many photos may be kept, when there's a limit (the hosted demo).
  readonly limit = input<number | null>(null);
  readonly remove = output<Photo>();
  // Use the stack a photo was made with again.
  readonly reuse = output<Photo>();

  // The photo whose delete button is asking "are you sure?".
  readonly confirming = signal<string | null>(null);
  readonly shareError = signal<string | null>(null);
  // The Web Share API with files: phones, and some desktop browsers.
  readonly canShare =
    typeof navigator !== 'undefined' && 'share' in navigator && 'canShare' in navigator;

  constructor() {
    effect(() => {
      const id = this.highlight();
      if (!id || !this.photos().some((p) => p._id === id)) return;
      // After the new card is in the page.
      requestAnimationFrame(() => {
        const card = (this.host.nativeElement as HTMLElement).querySelector(
          '#photo-' + CSS.escape(id),
        );
        const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        card?.scrollIntoView?.({ behavior: still ? 'auto' : 'smooth', block: 'center' });
      });
    });
  }

  label(photo: Photo): string {
    return photoLabel(this.filters(), photo);
  }

  fileName(photo: Photo): string {
    return downloadName(this.label(photo), photo);
  }

  async share(photo: Photo): Promise<void> {
    this.shareError.set(null);
    try {
      const blob = await (await fetch(photo.content)).blob();
      const file = new File([blob], this.fileName(photo), { type: blob.type });
      if (!navigator.canShare({ files: [file] })) {
        this.shareError.set("This browser can't share images; use Save instead.");
        return;
      }
      await navigator.share({ files: [file], title: this.label(photo) });
    } catch (err) {
      // Closing the share sheet isn't an error.
      if ((err as Error)?.name !== 'AbortError') this.shareError.set('Could not share that photo.');
    }
  }

  confirmDelete(photo: Photo): void {
    this.confirming.set(null);
    this.remove.emit(photo);
  }
}
