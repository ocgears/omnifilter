var angular = require('angular');

describe('auth controller 1', () => {
  var $httpBackend;
  var $scope;
  var $ControllerConstructor;

  beforeEach(angular.mock.module('omnifilterApp'));

  beforeEach(angular.mock.inject(function($rootScope, $controller) {
    $ControllerConstructor = $controller;
    $scope = $rootScope.$new();
  }));

  it('should be able to make a controller', () => {
    var authController = $ControllerConstructor('authController', {$scope});
    expect(typeof authController).toBe('object');
    expect(typeof $scope.updateEmail).toBe('function');
  });
});
