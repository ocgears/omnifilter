import { Routes } from '@angular/router';

// Each page is a chunk of its own, loaded when it's visited, so the photo
// page doesn't wait for the sign-in form's code (Angular's forms) or the
// rest.
const authPage = () => import('./auth/auth-page').then((m) => m.AuthPage);

// The photo page opens straight away, with an account or as a guest (unless
// the server doesn't take guests; see the editor).
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'home' },
  { path: 'signin', loadComponent: authPage, title: 'Sign in · OmniFilter' },
  {
    path: 'signup',
    loadComponent: authPage,
    data: { signup: true },
    title: 'Create an account · OmniFilter',
  },
  {
    path: 'home',
    loadComponent: () => import('./editor/editor').then((m) => m.Editor),
    title: 'OmniFilter',
  },
  {
    path: '**',
    loadComponent: () => import('./not-found/not-found').then((m) => m.NotFound),
    title: 'Page not found · OmniFilter',
  },
];
