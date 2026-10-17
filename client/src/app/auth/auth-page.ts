import { Component, inject, input, signal } from '@angular/core';
import { FormField, email, form, required, validate } from '@angular/forms/signals';
import { Router, RouterLink } from '@angular/router';
import { Alerts } from '../alerts/alerts';
import { AuthService, errorMessage } from '../auth.service';

const MIN_PASSWORD_LENGTH = 8;

// Signing in, and (with the route's `signup` data) making an account.
@Component({
  selector: 'of-auth-page',
  imports: [Alerts, FormField, RouterLink],
  templateUrl: './auth-page.html',
  styleUrl: './auth-page.scss',
})
export class AuthPage {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  // From the route's data (app.routes.ts).
  readonly signup = input(false);

  readonly errors = signal<string[]>([]);
  readonly busy = signal(false);

  private readonly model = signal({ email: '', password: '', confirmation: '' });
  readonly authForm = form(this.model, (f) => {
    required(f.email, { message: 'Enter your email address' });
    email(f.email, { message: "That doesn't look like an email address" });
    required(f.password, { message: 'Enter your password' });
    validate(f.password, ({ value }) =>
      this.signup() && value().length < MIN_PASSWORD_LENGTH
        ? { kind: 'minLength', message: 'Use at least ' + MIN_PASSWORD_LENGTH + ' characters' }
        : null,
    );
    validate(f.confirmation, ({ value, valueOf }) =>
      this.signup() && value() !== valueOf(f.password)
        ? { kind: 'match', message: "The passwords don't match" }
        : null,
    );
  });

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.authForm().invalid() || this.busy()) return;
    const user = this.model();
    this.busy.set(true);
    try {
      if (this.signup()) await this.auth.signUp(user);
      else await this.auth.signIn(user);
      await this.router.navigateByUrl('/home');
    } catch (err) {
      // Only the server's message: the error object also holds the request,
      // password included.
      this.errors.update((list) => [
        ...list,
        errorMessage(err, this.signup() ? 'Could not sign up.' : 'Could not sign in.'),
      ]);
    } finally {
      this.busy.set(false);
    }
  }

  dismissError(index: number): void {
    this.errors.update((list) => list.filter((_, i) => i !== index));
  }
}
