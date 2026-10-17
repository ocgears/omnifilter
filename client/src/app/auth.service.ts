import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API_BASE } from './api-base';

const TOKEN_KEY = 'token';

// Base64 of the UTF-8 bytes of a string. btoa alone only takes Latin-1 (and
// throws on anything past U+00FF, like '€'), while the server decodes the
// Basic auth header as UTF-8.
export function base64Utf8(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// The server's message from a failed request, or the fallback.
export function errorMessage(err: unknown, fallback: string): string {
  const msg = err instanceof HttpErrorResponse ? err.error?.msg : null;
  return typeof msg === 'string' && msg ? msg : fallback;
}

// localStorage can throw (private windows, blocked site data).
function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // The token still lives in memory for this visit.
  }
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly apiBase = inject(API_BASE);

  readonly token = signal<string | null>(readToken());
  // The signed-in user's email, once the server has confirmed the token.
  readonly email = signal<string | null>(null);
  // Set when there's a token but the server couldn't be asked whose it is.
  readonly unverified = signal(false);
  // Why the sign-in page is shown, when it's because the last one ended.
  readonly notice = signal<string | null>(null);

  async signUp(user: { email: string; password: string; confirmation: string }): Promise<void> {
    const res = await firstValueFrom(
      this.http.post<{ token: string }>(this.apiBase + '/signup', user),
    );
    this.setToken(res.token);
    this.notice.set(null);
    await this.verify();
  }

  async signIn(user: { email: string; password: string }): Promise<void> {
    const res = await firstValueFrom(
      this.http.get<{ token: string }>(this.apiBase + '/signin', {
        headers: { Authorization: 'Basic ' + base64Utf8(user.email + ':' + user.password) },
      }),
    );
    this.setToken(res.token);
    this.notice.set(null);
    await this.verify();
  }

  // Asks the server whose the token is. A token it rejects is no use, so it's
  // forgotten; if the server couldn't be reached (or failed), it's kept and
  // signing out stays available.
  async verify(): Promise<void> {
    const token = this.token();
    if (!token) {
      this.email.set(null);
      this.unverified.set(false);
      return;
    }
    try {
      const res = await firstValueFrom(
        this.http.get<{ email: string }>(this.apiBase + '/verify', { headers: { token } }),
      );
      this.email.set(res?.email || null);
      this.unverified.set(false);
    } catch (err) {
      this.email.set(null);
      const status = err instanceof HttpErrorResponse ? err.status : 0;
      if (status === 401 || status === 403) this.signOut();
      else this.unverified.set(true);
    }
  }

  // The server no longer takes the token (auth.interceptor.ts).
  expired(): void {
    this.signOut();
    this.notice.set('Your sign-in has expired. Sign in again to carry on.');
  }

  signOut(): void {
    this.setToken(null);
    this.email.set(null);
    this.unverified.set(false);
  }

  private setToken(token: string | null): void {
    writeToken(token);
    this.token.set(token);
  }
}
