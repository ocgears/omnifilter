// The app's IndexedDB database: the work in progress (editor/draft-store.ts)
// and photos made as a guest (guest-photos.ts). IndexedDB rather than
// localStorage, which only holds a few megabytes. It can be missing or refuse
// to open (private windows, blocked site data, tests), and then nothing is
// kept: every function here resolves with undefined instead of failing.

const DB_NAME = 'omnifilter';
const VERSION = 2;
export const STORES = ['draft', 'photos'] as const;
export type Store = (typeof STORES)[number];

let db: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  db ??= new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        for (const name of STORES) {
          if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return db;
}

// Runs one request on a store and resolves with its result.
export async function request<T>(
  store: Store,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<T | undefined> {
  const database = await open();
  if (!database) return undefined;
  return new Promise((resolve) => {
    try {
      const req = run(database.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}
