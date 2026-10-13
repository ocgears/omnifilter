var angular = require('angular');

describe('auth controller basic', () => {
  var $httpBackend;
  var $scope;
  var $ControllerConstructor;
  var $location;

  beforeEach(angular.mock.module('omnifilterApp'));

  beforeEach(angular.mock.inject(function($rootScope, $controller, _$location_) {
    $ControllerConstructor = $controller;
    $scope = $rootScope.$new();
    $location = _$location_;
  }));

  it('should be able to make a controller', () => {
    var authController = $ControllerConstructor('authController', { $scope });
    expect(typeof authController).toBe('object');
    expect(typeof $scope.updateEmail).toBe('function');
    expect(typeof $scope.logout).toBe('function');
  });

  describe('function calls', () => {
    beforeEach(angular.mock.inject(function(_$httpBackend_) {
      $httpBackend = _$httpBackend_;
      $ControllerConstructor('authController', { $scope });
    }));

    afterEach(() => {
      $httpBackend.verifyNoOutstandingExpectation();
      $httpBackend.verifyNoOutstandingRequest();
    });

    it('should call to updateEmail', () => {
      $scope.email = null;
      $httpBackend.expectGET('http://localhost:3000/verify')
      .respond(200, { email: 'tester' });
      $scope.updateEmail();
      $httpBackend.flush();
      expect($scope.email).toBe('tester');
    });

    it('keeps logout available when the API cannot be reached', angular.mock.inject(function($window) {
      $window.localStorage.token = 'still-mine';
      $httpBackend.expectGET('http://localhost:3000/verify').respond(-1, null);
      $scope.updateEmail();
      $httpBackend.flush();
      expect($scope.email).toBe(null);
      expect($scope.unverified).toBe(true);
      expect($window.localStorage.token).toBe('still-mine');
      $scope.logout();
      expect($scope.unverified).toBe(false);
      expect($window.localStorage.token).toBe(undefined);
      expect($location.path()).toBe('/signin');
    }));

    it('forgets a token the server rejects', angular.mock.inject(function($window) {
      $window.localStorage.token = 'expired';
      $httpBackend.expectGET('http://localhost:3000/verify').respond(401, { msg: 'no' });
      $scope.updateEmail();
      $httpBackend.flush();
      expect($scope.email).toBe(null);
      expect($scope.unverified).toBe(false);
      expect($window.localStorage.token).toBe(undefined);
    }));

    it('should call to log out path', () => {
      $scope.email = 'testemail@super.net';
      $scope.logout();
      expect($scope.email).toBe(null);
      expect($location.path()).toBe('/signin');
    });
  });
});
