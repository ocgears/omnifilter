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

@Injectable({ providedIn: 'root' })
export class DraftStore {
  async load(): Promise<Draft> {
    const [photo, stack] = await Promise.all([
      request<DraftPhoto>('draft', 'readonly', (s) => s.get('photo')),
      request<DraftStack>('draft', 'readonly', (s) => s.get('stack')),
    ]);
    return { photo: photo ?? null, stack: stack ?? null };
  }

  async savePhoto(photo: DraftPhoto | null): Promise<void> {
    await request('draft', 'readwrite', (s) =>
      photo ? s.put(photo, 'photo') : s.delete('photo'),
    );
  }

  async saveStack(stack: DraftStack): Promise<void> {
    await request('draft', 'readwrite', (s) => s.put(stack, 'stack'));
  }

  // Forgets the draft, e.g. on signing out of a shared computer.
  async clear(): Promise<void> {
    await request('draft', 'readwrite', (s) => s.clear());
  }
}
