import { Component, afterNextRender, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { AuthService, errorMessage } from './auth.service';

// The page around every view: the header with the account, and the footer.
@Component({
  selector: 'of-root',
  imports: [RouterLink, RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly router = inject(Router);
  protected readonly auth = inject(AuthService);
  protected readonly year = new Date().getFullYear();
  // "Sign out of all devices", in the footer: asked to be sure first.
  protected readonly confirmEverywhere = signal(false);
  protected readonly signingOutEverywhere = signal(false);
  protected readonly everywhereError = signal<string | null>(null);

  constructor() {
    // window.omnifilterGpu, the browser's filter engine, for the end-to-end
    // tests and the console. Loaded once the page is idle, in its own chunk
    // (which the photo page uses too), so it doesn't hold up opening it.
    afterNextRender(() => {
      const idle = window.requestIdleCallback ?? ((run: () => void) => setTimeout(run, 1000));
      idle(() => import('../gpu').then((gpu) => gpu.installDebugApi(window)));
    });
    // A saved token the server no longer accepts is forgotten, and its owner
    // is asked to sign in again. (Without a token to begin with, the photo
    // page is a guest's, and stays.)
    const hadToken = !!this.auth.token();
    this.auth.verify().then(() => {
      if (hadToken && !this.auth.token() && this.router.url.startsWith('/home')) {
        this.router.navigateByUrl('/signin');
      }
    });
  }

  signOut(): void {
    this.auth.signOut();
    this.router.navigateByUrl('/signin');
  }

  async signOutEverywhere(): Promise<void> {
    this.signingOutEverywhere.set(true);
    this.everywhereError.set(null);
    try {
      await this.auth.signOutEverywhere();
      this.confirmEverywhere.set(false);
      this.router.navigateByUrl('/signin');
    } catch (err) {
      this.everywhereError.set(errorMessage(err, 'Could not sign out of the other devices.'));
    } finally {
      this.signingOutEverywhere.set(false);
    }
  }
}
