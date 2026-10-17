import { InjectionToken } from '@angular/core';

// Where the API lives, used for every request the client makes.
//
// By default it's port 3000 on the host that served the page, which is how
// `npm start` and docker-compose.yml run it. To point the client somewhere
// else, set either of these in index.html before the app's scripts load:
//   <script>window.OMNIFILTER_API = 'https://api.example.com';</script>
//   <meta name="omnifilter-api" content="https://api.example.com">
// (`OMNIFILTER_API=... npm run build` writes the meta tag for you.) An empty
// value or '/' means the API is on the same origin as the page, for when the
// API server also serves the client.
export function apiBaseFrom(win: Window & { OMNIFILTER_API?: unknown }): string {
  // Only a string: an element with id="OMNIFILTER_API" also shows up as
  // window.OMNIFILTER_API.
  let override: string | null = typeof win.OMNIFILTER_API === 'string' ? win.OMNIFILTER_API : null;
  if (override === null) {
    const meta = win.document.querySelector('meta[name="omnifilter-api"]');
    override = meta ? meta.getAttribute('content') : null;
  }
  if (override !== null) {
    return override.trim().replace(/\/+$/, '');
  }
  return win.location.protocol + '//' + win.location.hostname + ':3000';
}

export const API_BASE = new InjectionToken<string>('API_BASE', {
  providedIn: 'root',
  factory: () => apiBaseFrom(window),
});
