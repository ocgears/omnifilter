import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

bootstrapApplication(App, appConfig).catch((err) => console.error(err));

// The service worker takes photos shared from other apps once OmniFilter is
// installed (public/sw.js); it caches nothing. Registered after the page has
// loaded, so it doesn't compete with it.
if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker:', err));
  });
}
