import { Injectable } from '@angular/core';
import { request } from '../browser-db';
import { HistoryStep } from './history';

// The work in progress, kept in the browser so that a reload (which phones do
// to background tabs) or a closed tab doesn't lose it. The photo is saved
// only when it changes, since it can be megabytes; the stack and its history
// are small and saved after every edit.
export interface DraftPhoto {
  source: string;
  name: string;
}

export interface DraftStack {
  steps: HistoryStep[];
  index: number;
}

export interface Draft {
  photo: DraftPhoto | null;
  stack: DraftStack | null;
}

// What's stored for the photo: the file itself (a Blob, a third smaller than
// its data URL), or, from older versions, the data URL.
interface StoredPhoto {
  file?: Blob;
  source?: string;
  name: string;
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

@Injectable({ providedIn: 'root' })
export class DraftStore {
  // Saves of the photo, one after another: making the file takes a moment,
  // and a newer save mustn't land first.
  private photoSaves: Promise<unknown> = Promise.resolve();

  async load(): Promise<Draft> {
    const [stored, stack] = await Promise.all([
      request<StoredPhoto>('draft', 'readonly', (s) => s.get('photo')),
      request<DraftStack>('draft', 'readonly', (s) => s.get('stack')),
    ]);
    let photo: DraftPhoto | null = null;
    try {
      const source = stored?.file ? await readAsDataUrl(stored.file) : stored?.source;
      if (source) photo = { source, name: stored!.name };
    } catch {
      // A draft that can't be read back is no draft.
    }
    return { photo, stack: stack ?? null };
  }

  savePhoto(photo: DraftPhoto | null): Promise<void> {
    const save = this.photoSaves.then(async () => {
      if (!photo) return request('draft', 'readwrite', (s) => s.delete('photo'));
      const file = await (await fetch(photo.source)).blob();
      const stored: StoredPhoto = { file, name: photo.name };
      return request('draft', 'readwrite', (s) => s.put(stored, 'photo'));
    });
    this.photoSaves = save.catch(() => undefined);
    return save.then(
      () => undefined,
      () => undefined,
    );
  }

  async saveStack(stack: DraftStack): Promise<void> {
    await request('draft', 'readwrite', (s) => s.put(stack, 'stack'));
  }

  // Forgets the draft, e.g. on signing out of a shared computer.
  async clear(): Promise<void> {
    await this.photoSaves;
    await request('draft', 'readwrite', (s) => s.clear());
  }
}
