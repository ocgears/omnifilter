import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { App } from './app';
import { AuthService } from './auth.service';

describe('App', () => {
  let auth: {
    token: ReturnType<typeof signal<string | null>>;
    email: ReturnType<typeof signal<string | null>>;
    unverified: ReturnType<typeof signal<boolean>>;
    verify: ReturnType<typeof vi.fn>;
    signOut: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    auth = {
      token: signal<string | null>('tok'),
      email: signal<string | null>('a@b.co'),
      unverified: signal(false),
      verify: vi.fn().mockResolvedValue(undefined),
      signOut: vi.fn(),
    };
    TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([]), { provide: AuthService, useValue: auth }],
    });
  });

  it('checks the saved token, and shows who is signed in with a way to sign out', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(auth.verify).toHaveBeenCalled();
    expect(el.querySelector('.email')?.textContent).toBe('a@b.co');
    expect(el.querySelector('footer')?.textContent).toContain('MIT license');

    el.querySelector<HTMLButtonElement>('.account button')!.click();
    expect(auth.signOut).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/signin');
  });

  it("keeps sign out available when the server can't be reached", async () => {
    auth.email.set(null);
    auth.unverified.set(true);
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.offline')?.textContent).toContain("Can't reach the server");
    expect(el.querySelector('.account button')?.textContent).toContain('Sign out');
  });
});
