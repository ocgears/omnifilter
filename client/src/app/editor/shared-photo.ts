// A photo shared to OmniFilter from another app (Share → OmniFilter in a
// phone's gallery, once the app is installed). The service worker
// (public/sw.js) keeps it in Cache Storage under these names, and the photo
// page takes it from there, once.

export const SHARED_CACHE = 'omnifilter-shared';
export const SHARED_KEY = '/shared-photo';

// The shared photo waiting, if there is one, removed so it's used once.
export async function takeSharedPhoto(
  storage: CacheStorage | undefined = globalThis.caches,
): Promise<File | null> {
  if (!storage) return null;
  try {
    if (!(await storage.has(SHARED_CACHE))) return null;
    const cache = await storage.open(SHARED_CACHE);
    const res = await cache.match(SHARED_KEY);
    await storage.delete(SHARED_CACHE);
    if (!res) return null;
    const blob = await res.blob();
    const name = decodeURIComponent(res.headers.get('Omnifilter-Name') || 'Shared photo');
    return new File([blob], name, { type: res.headers.get('Content-Type') || blob.type });
  } catch {
    // Storage the browser won't open (private windows, some WebViews).
    return null;
  }
}
