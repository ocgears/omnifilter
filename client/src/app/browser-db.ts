// The app's IndexedDB database: the work in progress (editor/draft-store.ts)
// and photos made as a guest (guest-photos.ts). IndexedDB rather than
// localStorage, which only holds a few megabytes. It can be missing or refuse
// to open (private windows, blocked site data, tests), and then nothing is
// kept: request() resolves with undefined instead of failing, which suits
// the draft, kept only in case. write() is for what the visitor asked to
// keep, so it fails instead, and only once the browser has stored it.

const DB_NAME = 'omnifilter';
const VERSION = 2;
export const STORES = ['draft', 'photos'] as const;
export type Store = (typeof STORES)[number];

let db: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  db ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        for (const name of STORES) {
          if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
        }
      };
      req.onsuccess = () => {
        const database = req.result;
        // Another tab with a newer version of the app wants to upgrade the
        // database, or the browser closed it: let go, and open it again next
        // time.
        database.onversionchange = () => {
          database.close();
          db = null;
        };
        database.onclose = () => (db = null);
        resolve(database);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  }).then((database) => {
    // A failure may not last (another tab was in the way), so the next call
    // tries again.
    if (!database) db = null;
    return database;
  });
  return db;
}

// Runs one request on a store and resolves with its result, or undefined if
// it couldn't be run.
export async function request<T>(
  store: Store,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<T | undefined> {
  return write<T>(store, mode, run).catch(() => undefined);
}

export class BrowserStorageError extends Error {}

// Runs one request on a store and resolves with its result once its
// transaction has finished (a write is only stored then: it can still fail,
// on a full disk, after the request itself succeeds), or rejects.
export async function write<T>(
  store: Store,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const database = await open();
  if (!database)
    throw new BrowserStorageError("This browser isn't keeping anything for this site.");
  return new Promise<T>((resolve, reject) => {
    try {
      const tx = database.transaction(store, mode);
      const req = run(tx.objectStore(store));
      const failed = () =>
        reject(
          new BrowserStorageError(
            tx.error?.name === 'QuotaExceededError'
              ? 'This browser has no room left to keep photos for this site.'
              : 'This browser could not keep that.',
          ),
        );
      tx.oncomplete = () => resolve(req.result as T);
      tx.onerror = failed;
      tx.onabort = failed;
    } catch {
      reject(new BrowserStorageError('This browser could not keep that.'));
    }
  });
}

// A record holding a file (`file`, a Blob), as it's stored: Blobs where the
// browser stores them, else the file's bytes and type. Safari won't store
// Blobs in a private window (nor in Playwright's WebKit), but takes an
// ArrayBuffer.
export interface FileRecord {
  file?: Blob;
  fileBytes?: ArrayBuffer;
  fileType?: string;
}

// Stores `value` under `key`, with its file as a Blob or, if the browser
// refuses that, as bytes. Rejects as write() does.
export async function writeWithFile<T extends FileRecord>(
  store: Store,
  key: string,
  value: T,
): Promise<void> {
  try {
    await write(store, 'readwrite', (s) => s.put(value, key));
  } catch (err) {
    if (!value.file) throw err;
    const asBytes = {
      ...value,
      file: undefined,
      fileBytes: await value.file.arrayBuffer(),
      fileType: value.file.type,
    };
    await write(store, 'readwrite', (s) => s.put(asBytes, key));
  }
}

// A stored record with its file as a Blob again, however it was stored.
export function withFile<T extends FileRecord>(record: T): T {
  if (record.file || !record.fileBytes) return record;
  const { fileBytes, fileType, ...rest } = record;
  return { ...rest, file: new Blob([fileBytes], { type: fileType ?? '' }) } as T;
}
