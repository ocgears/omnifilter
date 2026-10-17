import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { AuthService } from '../auth.service';
import { AuthPage } from './auth-page';

describe('AuthPage', () => {
  let fixture: ComponentFixture<AuthPage>;
  let el: HTMLElement;
  let auth: {
    signIn: ReturnType<typeof vi.fn>;
    signUp: ReturnType<typeof vi.fn>;
    notice: ReturnType<typeof signal<string | null>>;
  };
  let navigate: ReturnType<typeof vi.spyOn>;

  async function create(signup: boolean): Promise<void> {
    fixture = TestBed.createComponent(AuthPage);
    fixture.componentRef.setInput('signup', signup);
    el = fixture.nativeElement;
    await fixture.whenStable();
  }

  async function type(id: string, value: string): Promise<void> {
    const input = el.querySelector<HTMLInputElement>('#' + id)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    await fixture.whenStable();
  }

  const button = () => el.querySelector<HTMLButtonElement>('button[type=submit]')!;

  async function submit(): Promise<void> {
    el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
  }

  beforeEach(() => {
    auth = {
      signIn: vi.fn().mockResolvedValue(undefined),
      signUp: vi.fn().mockResolvedValue(undefined),
      notice: signal<string | null>(null),
    };
    TestBed.configureTestingModule({
      imports: [AuthPage],
      providers: [provideRouter([]), { provide: AuthService, useValue: auth }],
    });
    navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
  });

  it('says why when a sign-in has expired', async () => {
    auth.notice.set('Your sign-in has expired. Sign in again to carry on.');
    await create(false);
    expect(el.querySelector('of-alerts')?.textContent).toContain('Your sign-in has expired');
  });

  it('signs in and goes to the photos', async () => {
    await create(false);
    expect(el.querySelector('h1')?.textContent).toContain('Sign in');
    expect(el.querySelector('#confirmation')).toBeNull();
    expect(button().disabled).toBe(true);
    await type('email', 'a@b.co');
    await type('password', 'secret');
    expect(button().disabled).toBe(false);
    await submit();
    expect(auth.signIn).toHaveBeenCalledWith({
      email: 'a@b.co',
      password: 'secret',
      confirmation: '',
    });
    expect(navigate).toHaveBeenCalledWith('/home');
  });

  it("shows only the server's message when sign in fails", async () => {
    auth.signIn.mockRejectedValue(
      new HttpErrorResponse({ status: 401, error: { msg: 'Invalid username or password' } }),
    );
    await create(false);
    await type('email', 'a@b.co');
    await type('password', 'wrong');
    await submit();
    expect(navigate).not.toHaveBeenCalled();
    expect(el.querySelector('[role=alert]')?.textContent).toContain('Invalid username or password');
  });

  it('asks for a long enough password, typed twice, to sign up', async () => {
    await create(true);
    expect(el.querySelector('h1')?.textContent).toContain('Create an account');
    await type('email', 'a@b.co');
    await type('password', 'short');
    expect(el.textContent).toContain('Use at least 8 characters');
    await type('password', 'long enough');
    await type('confirmation', 'long enougj');
    expect(el.textContent).toContain("The passwords don't match");
    expect(button().disabled).toBe(true);
    await type('confirmation', 'long enough');
    expect(button().disabled).toBe(false);
    await submit();
    expect(auth.signUp).toHaveBeenCalledWith({
      email: 'a@b.co',
      password: 'long enough',
      confirmation: 'long enough',
    });
    expect(navigate).toHaveBeenCalledWith('/home');
  });

  it('refuses an email address without a domain', async () => {
    await create(true);
    await type('email', 'nobody');
    expect(el.textContent).toContain("doesn't look like an email address");
  });
});
