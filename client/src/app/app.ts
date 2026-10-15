import { Component, inject } from '@angular/core';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { AuthService } from './auth.service';
import { DraftStore } from './editor/draft-store';

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
  private readonly drafts = inject(DraftStore);
  protected readonly year = new Date().getFullYear();

  constructor() {
    // window.omnifilterGpu, the browser's filter engine, for the end-to-end
    // tests and the console. Loaded after the page, in its own chunk (which
    // the photo page uses too).
    import('../gpu').then((gpu) => gpu.installDebugApi(window));
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
    // Someone else may use this browser next.
    this.drafts.clear();
    this.router.navigateByUrl('/signin');
  }
}
