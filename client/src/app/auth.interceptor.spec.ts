import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { API_BASE } from './api-base';
import { expiredSignIn } from './auth.interceptor';
import { AuthService } from './auth.service';

describe('expiredSignIn', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  let auth: AuthService;
  let navigate: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('token', 'old');
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([expiredSignIn])),
        provideHttpClientTesting(),
        { provide: API_BASE, useValue: 'http://api' },
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
    navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
  });

  afterEach(() => backend.verify());

  const call = (token?: string) =>
    firstValueFrom(http.get('http://api/getAll', { headers: token ? { token } : {} })).catch(
      (e) => e,
    );

  it('signs out and asks to sign in again when the token is turned away', async () => {
    const done = call('old');
    backend.expectOne('http://api/getAll').flush({ msg: 'no' }, { status: 401, statusText: 'No' });
    expect((await done).status).toBe(401);
    expect(auth.token()).toBeNull();
    expect(auth.notice()).toContain('expired');
    expect(navigate).toHaveBeenCalledWith('/signin');
  });

  it('leaves other failures, and other tokens, alone', async () => {
    let done = call('old');
    backend.expectOne('http://api/getAll').flush({}, { status: 403, statusText: 'No' });
    await done;
    done = call('another');
    backend.expectOne('http://api/getAll').flush({}, { status: 401, statusText: 'No' });
    await done;
    done = call();
    backend.expectOne('http://api/getAll').flush({}, { status: 401, statusText: 'No' });
    await done;
    expect(auth.token()).toBe('old');
    expect(navigate).not.toHaveBeenCalled();
  });
});
