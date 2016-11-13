var angular = require('angular');

describe('auth controller basic', () => {
  var $httpBackend;
  var $scope;
  var $ControllerConstructor;

  beforeEach(angular.mock.module('omnifilterApp'));

  beforeEach(angular.mock.inject(function($rootScope, $controller) {
    $ControllerConstructor = $controller;
    $scope = $rootScope.$new();
  }));

  it('should be able to make a controller', () => {
    var authController = $ControllerConstructor('authController', { $scope });
    expect(typeof authController).toBe('object');
    expect(typeof $scope.updateEmail).toBe('function');
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

    it('should call to verify path', () => {
      $scope.email = null;
      $httpBackend.expectGET('http://localhost:3000/verify')
      .respond(200, { email: 'tester' });
      $scope.updateEmail();
      $httpBackend.flush();
      expect($scope.email).toBe('tester');
    });

    it('should call to log out path', () => {
      $scope.email = 'testemail@super.net';
      $scope.logout();
      expect($scope.email).toBe(null);
    });

  });

});
