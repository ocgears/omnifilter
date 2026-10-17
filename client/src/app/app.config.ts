import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding, withHashLocation } from '@angular/router';
import { routes } from './app.routes';
import { expiredSignIn } from './auth.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // '#/home' style URLs, so any static file server (clientserver.js, the API
    // server, a CDN) can serve the app without rewriting paths to index.html.
    provideRouter(routes, withHashLocation(), withComponentInputBinding()),
    provideHttpClient(withFetch(), withInterceptors([expiredSignIn])),
  ],
};
