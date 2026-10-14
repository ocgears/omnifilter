import { Component, inject } from '@angular/core';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { AuthService } from './auth.service';

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

  constructor() {
    // A saved token the server no longer accepts is forgotten; then the photo
    // page has nothing to show.
    this.auth.verify().then(() => {
      if (!this.auth.token() && this.router.url.startsWith('/home')) {
        this.router.navigateByUrl('/signin');
      }
    });
  }

  signOut(): void {
    this.auth.signOut();
    this.router.navigateByUrl('/signin');
  }
}
