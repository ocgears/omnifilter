import { Injectable } from '@angular/core';
import { request, write } from './browser-db';
import { makeThumb } from './editor/photo-file';
import { Photo } from './models';

// Photos made without an account, which the server doesn't keep: they live
// in this browser until they're added to an account (POST /import) or
// deleted. Their ids start with LOCAL_ID.
export const LOCAL_ID = 'local-';

export const isLocal = (photo: Photo) => photo._id.startsWith(LOCAL_ID);

@Injectable({ providedIn: 'root' })
export class GuestPhotos {
  // Newest first, like the server's list.
  async list(): Promise<Photo[]> {
    const photos = (await request<Photo[]>('photos', 'readonly', (s) => s.getAll())) ?? [];
    return photos.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  }

  // Keeps a photo (its data URL in `content`), with a thumbnail for the
  // gallery, giving it a local id. Resolves with it once the browser has
  // stored it, or rejects with a BrowserStorageError if it can't.
  async add(photo: Omit<Photo, '_id'>): Promise<Photo> {
    const saved: Photo = {
      ...photo,
      thumb: photo.thumb ?? (photo.content ? await makeThumb(photo.content) : undefined),
      _id: LOCAL_ID + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      createdAt: photo.createdAt ?? new Date().toISOString(),
    };
    await write('photos', 'readwrite', (s) => s.put(saved, saved._id));
    return saved;
  }

  async remove(photo: Photo): Promise<void> {
    await request('photos', 'readwrite', (s) => s.delete(photo._id));
  }
}
