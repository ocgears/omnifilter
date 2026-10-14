import { Routes } from '@angular/router';
import { AuthPage } from './auth/auth-page';
import { NotFound } from './not-found/not-found';

// The photo page opens straight away, with an account or as a guest (unless
// the server doesn't take guests; see the editor).
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'home' },
  { path: 'signin', component: AuthPage, title: 'Sign in · OmniFilter' },
  {
    path: 'signup',
    component: AuthPage,
    data: { signup: true },
    title: 'Create an account · OmniFilter',
  },
  {
    path: 'home',
    loadComponent: () => import('./editor/editor').then((m) => m.Editor),
    title: 'OmniFilter',
  },
  { path: '**', component: NotFound, title: 'Page not found · OmniFilter' },
];
