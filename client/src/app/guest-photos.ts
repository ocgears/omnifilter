import { Injectable } from '@angular/core';
import { request, withFile, writeWithFile } from './browser-db';
import { makeThumb } from './editor/photo-file';
import { Photo } from './models';

// Photos made without an account, which the server doesn't keep: they live
// in this browser until they're added to an account (POST /import) or
// deleted. Their ids start with LOCAL_ID.
export const LOCAL_ID = 'local-';

export const isLocal = (photo: Photo) => photo._id.startsWith(LOCAL_ID);

// The photos are kept as files (Blobs), which IndexedDB stores as they are:
// a data URL is a third bigger, and a string that size is a burden on a
// phone's memory. Photos kept as data URLs by older versions are moved over
// the next time the list is read.
@Injectable({ providedIn: 'root' })
export class GuestPhotos {
  // Newest first, like the server's list.
  async list(): Promise<Photo[]> {
    const stored = (await request<Photo[]>('photos', 'readonly', (s) => s.getAll())) ?? [];
    const photos = stored.map(withFile);
    const upgraded = await Promise.all(photos.map((p) => this.upgrade(p)));
    return upgraded.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  }

  // A photo kept as a data URL, as a file with a thumbnail, stored again. As
  // it was if that fails: it still shows.
  private async upgrade(photo: Photo): Promise<Photo> {
    if (photo.file || !photo.content) return photo;
    try {
      const file = await (await fetch(photo.content)).blob();
      const moved: Photo = {
        ...photo,
        content: undefined,
        file,
        mime: file.type,
        thumb: photo.thumb ?? (await makeThumb(file)),
      };
      await writeWithFile('photos', moved._id, moved);
      return moved;
    } catch {
      return photo;
    }
  }

  // Keeps a photo (its file in `file`), with a thumbnail for the gallery,
  // giving it a local id. Resolves with it once the browser has stored it,
  // or rejects with a BrowserStorageError if it can't.
  async add(photo: Omit<Photo, '_id'>): Promise<Photo> {
    const source = photo.file ?? photo.content;
    const saved: Photo = {
      ...photo,
      thumb: photo.thumb ?? (source ? await makeThumb(source) : undefined),
      _id: LOCAL_ID + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      createdAt: photo.createdAt ?? new Date().toISOString(),
    };
    await writeWithFile('photos', saved._id, saved);
    return saved;
  }

  async remove(photo: Photo): Promise<void> {
    await request('photos', 'readwrite', (s) => s.delete(photo._id));
  }
}
