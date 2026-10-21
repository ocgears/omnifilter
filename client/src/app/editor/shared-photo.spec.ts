import { SHARED_CACHE, SHARED_KEY, takeSharedPhoto } from './shared-photo';

// Just enough of Cache Storage: named caches of one response each.
function fakeCaches(entries: Record<string, Response> = {}): CacheStorage {
  const caches = new Map<string, Map<string, Response>>(
    Object.keys(entries).length ? [[SHARED_CACHE, new Map(Object.entries(entries))]] : [],
  );
  return {
    has: async (name: string) => caches.has(name),
    open: async (name: string) => {
      if (!caches.has(name)) caches.set(name, new Map());
      const cache = caches.get(name)!;
      return { match: async (key: string) => cache.get(key) } as unknown as Cache;
    },
    delete: async (name: string) => caches.delete(name),
  } as unknown as CacheStorage;
}

describe('takeSharedPhoto', () => {
  it('takes the photo the service worker kept, once', async () => {
    const storage = fakeCaches({
      [SHARED_KEY]: new Response('jpeg bytes', {
        headers: {
          'Content-Type': 'image/jpeg',
          'Omnifilter-Name': encodeURIComponent('Beach day.jpg'),
        },
      }),
    });
    const file = await takeSharedPhoto(storage);
    expect(file?.name).toBe('Beach day.jpg');
    expect(file?.type).toBe('image/jpeg');
    expect(await file?.text()).toBe('jpeg bytes');
    expect(await takeSharedPhoto(storage)).toBeNull();
  });

  it('finds nothing when nothing was shared', async () => {
    expect(await takeSharedPhoto(fakeCaches())).toBeNull();
    expect(await takeSharedPhoto(undefined)).toBeNull();
  });

  it('finds nothing when the browser refuses the storage', async () => {
    const refusing = {
      has: () => Promise.reject(new DOMException('No', 'SecurityError')),
    } as unknown as CacheStorage;
    expect(await takeSharedPhoto(refusing)).toBeNull();
  });
});
