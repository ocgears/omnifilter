import { apiBaseFrom } from './api-base';

describe('apiBaseFrom', () => {
  function fakeWindow(opts: { override?: string | null; meta?: string } = {}) {
    return {
      OMNIFILTER_API: opts.override,
      location: { protocol: 'https:', hostname: 'photos.example' },
      document: {
        querySelector: () =>
          opts.meta === undefined ? null : { getAttribute: () => opts.meta as string },
      },
    } as unknown as Window & { OMNIFILTER_API?: string | null };
  }

  it("defaults to port 3000 on the page's host", () => {
    expect(apiBaseFrom(fakeWindow())).toBe('https://photos.example:3000');
  });

  it('uses window.OMNIFILTER_API when set, without a trailing slash', () => {
    expect(apiBaseFrom(fakeWindow({ override: 'https://api.example/' }))).toBe(
      'https://api.example',
    );
  });

  it('uses the omnifilter-api meta tag', () => {
    expect(apiBaseFrom(fakeWindow({ meta: ' https://api.example ' }))).toBe('https://api.example');
  });

  it('treats an empty or "/" setting as the same origin', () => {
    expect(apiBaseFrom(fakeWindow({ override: '' }))).toBe('');
    expect(apiBaseFrom(fakeWindow({ override: '/' }))).toBe('');
    expect(apiBaseFrom(fakeWindow({ meta: '/' }))).toBe('');
  });
});
