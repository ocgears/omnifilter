import { Injectable } from '@angular/core';
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

const DB_NAME = 'omnifilter';
const STORE = 'draft';

// IndexedDB rather than localStorage: photos are too big for localStorage's
// few megabytes. It can be missing or refuse to open (private windows,
// blocked site data, tests), and then nothing is kept.
@Injectable({ providedIn: 'root' })
export class DraftStore {
  private db: Promise<IDBDatabase | null> | null = null;

  private open(): Promise<IDBDatabase | null> {
    this.db ??= new Promise((resolve) => {
      try {
        if (typeof indexedDB === 'undefined') return resolve(null);
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this.db;
  }

  private async request<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest,
  ): Promise<T | undefined> {
    const db = await this.open();
    if (!db) return undefined;
    return new Promise((resolve) => {
      try {
        const req = run(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  }

  async load(): Promise<Draft> {
    const [photo, stack] = await Promise.all([
      this.request<DraftPhoto>('readonly', (s) => s.get('photo')),
      this.request<DraftStack>('readonly', (s) => s.get('stack')),
    ]);
    return { photo: photo ?? null, stack: stack ?? null };
  }

  async savePhoto(photo: DraftPhoto | null): Promise<void> {
    await this.request('readwrite', (s) => (photo ? s.put(photo, 'photo') : s.delete('photo')));
  }

  async saveStack(stack: DraftStack): Promise<void> {
    await this.request('readwrite', (s) => s.put(stack, 'stack'));
  }

  // Forgets the draft, e.g. on signing out of a shared computer.
  async clear(): Promise<void> {
    await this.request('readwrite', (s) => s.clear());
  }
}
