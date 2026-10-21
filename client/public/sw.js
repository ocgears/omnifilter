// The service worker, for one job: taking photos shared to OmniFilter from
// another app (the manifest's share_target), e.g. Share → OmniFilter in a
// phone's photo gallery, once the app is installed.
//
// The phone POSTs the photo to /share-target; this keeps it in Cache Storage
// and sends the app to the photo page, which takes it from there
// (src/app/editor/shared-photo.ts). Nothing else goes through here: every
// other request goes to the network as if there were no service worker, and
// nothing is cached for offline use.
'use strict';

const SHARED_CACHE = 'omnifilter-shared';
const SHARED_KEY = '/shared-photo';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.pathname !== '/share-target') return;
  event.respondWith(takeShared(event.request));
});

async function takeShared(request) {
  try {
    const form = await request.formData();
    const photo = form.getAll('photo').find((f) => f instanceof File && f.size > 0);
    const cache = await caches.open(SHARED_CACHE);
    if (photo) {
      await cache.put(
        SHARED_KEY,
        new Response(photo, {
          headers: {
            'Content-Type': photo.type || 'application/octet-stream',
            'Omnifilter-Name': encodeURIComponent(photo.name || 'Shared photo'),
          },
        }),
      );
    }
  } catch (err) {
    // The app opens anyway, without the photo.
    console.error('Share target:', err);
  }
  return Response.redirect(new URL('/#/home', self.location.origin).href, 303);
}
