import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { API_BASE } from './api-base';
import { AuthService, base64Utf8 } from './auth.service';
import { DraftStore } from './editor/draft-store';

describe('AuthService', () => {
  let auth: AuthService;
  let http: HttpTestingController;
  let clearDraft: ReturnType<typeof vi.fn>;

  // Lets the service's awaited requests reach the testing backend.
  const tick = () => new Promise((resolve) => setTimeout(resolve));

  beforeEach(() => {
    localStorage.clear();
    clearDraft = vi.fn(() => Promise.resolve());
    TestBed.configureTestingModule({
      providers: [
        { provide: DraftStore, useValue: { clear: clearDraft } },
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE, useValue: 'http://api' },
      ],
    });
    auth = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('encodes Basic auth as UTF-8', () => {
    expect(base64Utf8('a:€')).toBe(btoa('a:\u00e2\u0082\u00ac'));
  });

  it('signs in with a non-ASCII password, keeps the token and learns the email', async () => {
    const done = auth.signIn({ email: 'a@b.co', password: 'pässwörd€' });
    const signin = http.expectOne('http://api/signin');
    expect(signin.request.headers.get('Authorization')).toBe(
      'Basic ' + base64Utf8('a@b.co:pässwörd€'),
    );
    signin.flush({ token: 'tok' });
    await tick();
    const verify = http.expectOne('http://api/verify');
    expect(verify.request.headers.get('token')).toBe('tok');
    verify.flush({ email: 'a@b.co' });
    await done;

    expect(auth.token()).toBe('tok');
    expect(localStorage.getItem('token')).toBe('tok');
    expect(auth.email()).toBe('a@b.co');
  });

  it('signs up with the form fields', async () => {
    const user = { email: 'a@b.co', password: 'longenough', confirmation: 'longenough' };
    const done = auth.signUp(user);
    const signup = http.expectOne('http://api/signup');
    expect(signup.request.method).toBe('POST');
    expect(signup.request.body).toEqual(user);
    signup.flush({ token: 'tok' });
    await tick();
    http.expectOne('http://api/verify').flush({ email: 'a@b.co' });
    await done;
    expect(auth.email()).toBe('a@b.co');
  });

  it("rejects with the server's answer when sign in fails", async () => {
    const done = auth.signIn({ email: 'a@b.co', password: 'nope' });
    http
      .expectOne('http://api/signin')
      .flush({ msg: 'Invalid' }, { status: 401, statusText: 'No' });
    await expect(done).rejects.toMatchObject({ status: 401 });
    expect(auth.token()).toBeNull();
  });

  it('forgets a token the server rejects', async () => {
    auth.token.set('old');
    localStorage.setItem('token', 'old');
    const done = auth.verify();
    http.expectOne('http://api/verify').flush({}, { status: 401, statusText: 'No' });
    await done;
    expect(auth.token()).toBeNull();
    expect(localStorage.getItem('token')).toBeNull();
    expect(auth.unverified()).toBe(false);
  });

  it("keeps the token, and signing out, when the API can't be reached", async () => {
    auth.token.set('tok');
    const done = auth.verify();
    http.expectOne('http://api/verify').error(new ProgressEvent('error'));
    await done;
    expect(auth.token()).toBe('tok');
    expect(auth.email()).toBeNull();
    expect(auth.unverified()).toBe(true);
  });

  it('signs out', () => {
    auth.token.set('tok');
    auth.email.set('a@b.co');
    localStorage.setItem('token', 'tok');
    auth.signOut();
    expect(auth.token()).toBeNull();
    expect(auth.email()).toBeNull();
    expect(localStorage.getItem('token')).toBeNull();
    expect(clearDraft).toHaveBeenCalled();
  });

  it('follows a sign-out in another tab', async () => {
    auth.token.set('tok');
    auth.email.set('a@b.co');
    window.dispatchEvent(new StorageEvent('storage', { key: 'token', newValue: null }));
    await tick();
    expect(auth.token()).toBeNull();
    expect(auth.email()).toBeNull();
  });

  it('forgets the draft when the server stops taking the token too', async () => {
    auth.token.set('tok');
    const done = auth.verify();
    http.expectOne('http://api/verify').flush({ msg: 'no' }, { status: 401, statusText: 'Unauthorized' });
    await done;
    expect(auth.token()).toBeNull();
    expect(clearDraft).toHaveBeenCalled();
  });
});
