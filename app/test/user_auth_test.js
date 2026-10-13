var angular = require('angular');

describe('userAuth service', () => {
  var $httpBackend;
  var userAuth;

  beforeEach(angular.mock.module('omnifilterApp'));

  beforeEach(angular.mock.inject(function(_$httpBackend_, _userAuth_) {
    $httpBackend = _$httpBackend_;
    userAuth = _userAuth_;
  }));

  afterEach(() => {
    $httpBackend.verifyNoOutstandingExpectation();
    $httpBackend.verifyNoOutstandingRequest();
  });

  it('sends a non-ASCII password as UTF-8 in the Basic auth header', () => {
    // 'pässwörd€✓': btoa alone throws on € and ✓, and would send ä and ö as
    // Latin-1 bytes, which the server (decoding UTF-8) wouldn't match.
    var user = { email: 'tester@example.com', password: 'pässwörd€✓' };
    var done = jasmine.createSpy('done');
    $httpBackend.expectGET('http://localhost:3000/signin', function(headers) {
      return headers.Authorization === 'Basic dGVzdGVyQGV4YW1wbGUuY29tOnDDpHNzd8O2cmTigqzinJM=';
    }).respond(200, { token: 'tokenstring' });
    userAuth.signIn(user, done);
    $httpBackend.flush();
    expect(done).toHaveBeenCalledWith(null);
  });

  it('calls back with the error when the API cannot be reached', () => {
    var cb = jasmine.createSpy('cb');
    $httpBackend.expectGET('http://localhost:3000/verify').respond(-1, null);
    userAuth.getEmail(cb);
    $httpBackend.flush();
    expect(cb.calls.mostRecent().args[0].status).toBe(-1);
  });
});

describe('apiBase', () => {
  var apiBaseFrom = require('../js/services/api_base').apiBaseFrom;

  function fakeWindow(extra, metaContent) {
    return angular.extend({
      location: { protocol: 'https:', hostname: 'photos.example.org', port: '5000' },
      document: {
        querySelector: function(selector) {
          expect(selector).toBe('meta[name="omnifilter-api"]');
          return metaContent === undefined ? null : { getAttribute: () => metaContent };
        }
      }
    }, extra);
  }

  it('defaults to port 3000 on the page\'s host', () => {
    expect(apiBaseFrom(fakeWindow())).toBe('https://photos.example.org:3000');
  });

  it('uses window.OMNIFILTER_API when set', () => {
    expect(apiBaseFrom(fakeWindow({ OMNIFILTER_API: 'https://api.example.org/' })))
      .toBe('https://api.example.org');
  });

  it('uses the omnifilter-api meta tag', () => {
    expect(apiBaseFrom(fakeWindow({}, 'https://api.example.org'))).toBe('https://api.example.org');
  });

  it('treats an empty or "/" setting as the same origin', () => {
    expect(apiBaseFrom(fakeWindow({}, '/'))).toBe('');
    expect(apiBaseFrom(fakeWindow({}, ''))).toBe('');
    expect(apiBaseFrom(fakeWindow({ OMNIFILTER_API: '' }))).toBe('');
  });
});

// Minified code renames function parameters, so every injectable has to name
// its dependencies explicitly. strictDi fails on any that don't.
describe('minification-safe dependency injection', () => {
  it('creates every controller and directive with strictDi on', () => {
    var injector = angular.injector(['ng', 'ngMock', 'omnifilterTemplates', 'omnifilterApp'], true);
    var $rootScope = injector.get('$rootScope');
    var $controller = injector.get('$controller');
    ['authController', 'SigninController', 'SignupController', 'PhotosController'].forEach((name) => {
      expect(() => $controller(name, { $scope: $rootScope.$new() })).not.toThrow();
    });
    injector.get('$templateCache').put('/templates/photos/directives/photo_form_directive.html',
      '<div></div>');
    injector.get('$templateCache').put('/templates/photos/directives/photo.html', '<div></div>');
    var scope = $rootScope.$new();
    scope.photo = {};
    injector.get('$compile')('<div><photo-form photo="photo"></photo-form>' +
      '<photo photo-data="photo"></photo></div>')(scope);
    expect(() => scope.$digest()).not.toThrow();
  });
});
