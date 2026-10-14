import { inject } from '@angular/core';
import { Router, Routes } from '@angular/router';
import { AuthPage } from './auth/auth-page';
import { AuthService } from './auth.service';
import { NotFound } from './not-found/not-found';

// The photo page needs an account; without a token, go and sign in.
const signedIn = () => !!inject(AuthService).token() || inject(Router).parseUrl('/signin');

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'signin' },
  { path: 'signin', component: AuthPage, title: 'Sign in · OmniFilter' },
  {
    path: 'signup',
    component: AuthPage,
    data: { signup: true },
    title: 'Create an account · OmniFilter',
  },
  {
    path: 'home',
    canActivate: [signedIn],
    loadComponent: () => import('./editor/editor').then((m) => m.Editor),
    title: 'OmniFilter',
  },
  { path: '**', component: NotFound, title: 'Page not found · OmniFilter' },
];
