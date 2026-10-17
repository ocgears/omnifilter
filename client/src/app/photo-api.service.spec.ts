import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { API_BASE } from './api-base';
import { AuthService } from './auth.service';
import { PhotoApi } from './photo-api.service';

describe('PhotoApi', () => {
  let api: PhotoApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE, useValue: 'http://api' },
        { provide: AuthService, useValue: { token: signal('tok') } },
      ],
    });
    api = TestBed.inject(PhotoApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('sends a photo to keep as the file itself, with what it was made with in a header', async () => {
    const file = new Blob(['jpeg bytes'], { type: 'image/jpeg' });
    const done = api.import(
      {
        tStack: [{ tOption: 'sepia', tParams: { tone: 'café' }, amount: 60, blend: 'normal' }],
        createdAt: '2026-10-17T00:00:00.000Z',
      },
      file,
    );
    await new Promise((resolve) => setTimeout(resolve));
    const req = http.expectOne('http://api/import');
    expect(req.request.body).toBe(file);
    expect(req.request.headers.get('Content-Type')).toBe('image/jpeg');
    expect(req.request.headers.get('token')).toBe('tok');
    const recipe = req.request.headers.get('Omnifilter-Recipe')!;
    // Escaped to ASCII, as headers must be, and still the same JSON.
    expect(recipe).not.toMatch(/[^\x20-\x7e]/);
    expect(JSON.parse(recipe)).toEqual({
      createdAt: '2026-10-17T00:00:00.000Z',
      stack: [{ tOption: 'sepia', params: { tone: 'café' }, amount: 60, blend: 'normal' }],
    });
    req.flush({ _id: 'p1' });
    expect((await done)._id).toBe('p1');
  });

  it("gives back a photo kept in this browser from its own file, and keeps the server's", async () => {
    const file = new Blob(['png'], { type: 'image/png' });
    expect(await api.file({ _id: 'local-1', file })).toBe(file);
    const fetched = api.file({ _id: 'p2' });
    const req = http.expectOne('http://api/content/p2');
    req.flush(new Blob(['webp'], { type: 'image/webp' }));
    await fetched;
    expect(api.fileIfReady({ _id: 'p2' })?.type).toBe('image/webp');
  });
});
