var angular = require('angular');

describe('sign in controller basic', () => {
  var $httpBackend;
  var $scope;
  var $ControllerConstructor;
  var $window;
  var $location;
  var userAuth;

  beforeEach(angular.mock.module('omnifilterApp'));

  beforeEach(angular.mock.inject(function($rootScope, $controller, _$window_) {
    $ControllerConstructor = $controller;
    $scope = $rootScope.$new();
    $window = _$window_;
  }));

  it('should be able to make a controller', () => {

    var SigninController = $ControllerConstructor('SigninController', { $scope });
    expect(typeof SigninController).toBe('object');
    expect(typeof $scope.submit).toBe('function');
  });

  describe('function call', () => {
    beforeEach(angular.mock.inject(function(_$httpBackend_, _userAuth_) {
      $httpBackend = _$httpBackend_;
      $location = {};
      $location.path = function() { return 0; };
      userAuth = _userAuth_;
      $ControllerConstructor('SigninController', { $scope, $location, userAuth });
    }));

    afterEach(() => {
      $httpBackend.verifyNoOutstandingExpectation();
      $httpBackend.verifyNoOutstandingRequest();
    });

    it('should call to sign in', () => {
      var user = {
        password: 'testpass',
        email: 'InitTester'
      };
      $scope.updateEmail = function() {
        $scope.email = 'tester';
        $window.localStorage.token = 'tokenstring';
      };

      $scope.email = 'startValue';
      $httpBackend.expectGET('http://localhost:3000/signin')
      .respond(200, { token: 'tokenstring', email: 'tester' });
      $scope.submit(user);
      $httpBackend.flush();
      expect($scope.email).toBe('tester');
      expect($window.localStorage.token).toBe('tokenstring');
    });

    it('should have an error on bad input', () => {
      // sending nothing, should get error from function
      $scope.email = 'Bad Email : No at !';
      $window.localStorage.token = 'Testing';
      $scope.updateEmail = function() {
        // this should not be called, as the error causes a return before it
        $scope.email = null;
        $window.localStorage.token = 'handle Error';
      };
      var errMsg = 'No user email!';
      $httpBackend.expectGET('http://localhost:3000/signin')
      .respond(400, errMsg);
      $scope.submit('bad input');
      $httpBackend.flush();
      expect($scope.email).toBe('Bad Email : No at !');
      expect($window.localStorage.token).toBe('Testing');
    });
  });
});
