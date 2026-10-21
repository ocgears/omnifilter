import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { AuthService, errorMessage } from './auth.service';
import { refocus } from './focus';

// The page around every view: the header with the account, and the footer.
@Component({
  selector: 'of-root',
  imports: [RouterLink, RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly main = viewChild.required<ElementRef<HTMLElement>>('main');
  protected readonly auth = inject(AuthService);
  protected readonly year = new Date().getFullYear();
  // "Sign out of all devices", in the footer: asked to be sure first.
  protected readonly confirmEverywhere = signal(false);
  protected readonly signingOutEverywhere = signal(false);
  protected readonly everywhereError = signal<string | null>(null);

  constructor() {
    // On going to another page, the focus starts again from its main part,
    // as it would after loading a page, rather than on the link that went.
    let first = true;
    const navigations = this.router.events.subscribe((event) => {
      if (!(event instanceof NavigationEnd)) return;
      if (!first) refocus(this.injector, ['main'], { always: true });
      first = false;
    });
    inject(DestroyRef).onDestroy(() => navigations.unsubscribe());
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

  skipToMain(): void {
    this.main().nativeElement.focus();
  }

  // Asks before signing out everywhere, with the focus on Cancel; and back
  // to the button if cancelled.
  askEverywhere(asking: boolean): void {
    this.confirmEverywhere.set(asking);
    refocus(this.injector, [asking ? '.everywhere .cancel' : '.everywhere .ask'], {
      always: true,
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
