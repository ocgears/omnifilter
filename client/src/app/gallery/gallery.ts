import { DatePipe } from '@angular/common';
import { Component, ElementRef, effect, inject, input, output, signal } from '@angular/core';
import { errorMessage } from '../auth.service';
import { Filter, Photo } from '../models';
import { PhotoApi } from '../photo-api.service';
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
  const type = photo.mime ?? /^data:([^;,]+)/.exec(photo.content ?? '')?.[1] ?? '';
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

// The user's saved photos, newest first, to save, share or delete. The
// cards show thumbnails; Save and Share fetch the photo itself.
@Component({
  selector: 'of-gallery',
  imports: [DatePipe],
  templateUrl: './gallery.html',
  styleUrl: './gallery.scss',
})
export class Gallery {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly api = inject(PhotoApi);

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
  // The photo being fetched to save or share.
  readonly fetching = signal<string | null>(null);
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

  // The photo with its own name, fetched first if need be.
  private async file(photo: Photo): Promise<File | null> {
    this.fetching.set(photo._id);
    try {
      const blob = await this.api.file(photo);
      return new File([blob], this.fileName(photo), { type: blob.type });
    } catch (err) {
      this.shareError.set(errorMessage(err, 'Could not fetch that photo.'));
      return null;
    } finally {
      this.fetching.set(null);
    }
  }

  async save(photo: Photo): Promise<void> {
    this.shareError.set(null);
    const file = await this.file(photo);
    if (!file) return;
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.click();
    // After the browser has started the download.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async share(photo: Photo): Promise<void> {
    this.shareError.set(null);
    // Safari shares only straight from a tap, so a photo that has to be
    // fetched first is shared on the next one.
    const ready = this.api.fileIfReady(photo);
    let file: File | null;
    if (ready) {
      file = new File([ready], this.fileName(photo), { type: ready.type });
    } else {
      file = await this.file(photo);
      if (!file) return;
    }
    try {
      if (!navigator.canShare({ files: [file] })) {
        this.shareError.set("This browser can't share images; use Save instead.");
        return;
      }
      await navigator.share({ files: [file], title: this.label(photo) });
    } catch (err) {
      const name = (err as Error)?.name;
      // Closing the share sheet isn't an error.
      if (name === 'AbortError') return;
      this.shareError.set(
        name === 'NotAllowedError' && !ready
          ? 'The photo is ready: tap Share again to share it.'
          : 'Could not share that photo.',
      );
    }
  }

  confirmDelete(photo: Photo): void {
    this.confirming.set(null);
    this.remove.emit(photo);
  }
}
