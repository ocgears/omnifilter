const angular = require('angular');
require('angular-route');
require('ng-file-upload');
const omnifilterApp = angular.module('omnifilterApp', ['ngRoute', 'ngFileUpload']);

require('./services')(omnifilterApp);

require('./auth')(omnifilterApp);
require('./photos')(omnifilterApp);

omnifilterApp.config(['$routeProvider', function(routes) {
  routes
    .when('/home', {
      controller: 'PhotosController',
      templateUrl: '/views/photo_view.html'
    })
    .when('/signup', {
      controller: 'SignupController',
      templateUrl: '/views/sign_up_in_view.html'
    })
    .when('/signin', {
      controller: 'SigninController',
      templateUrl: '/views/sign_up_in_view.html'
    })
    .when('/', {
      redirectTo: '/signin'
    })
    .otherwise({
      templateUrl: '/views/four_oh_four.html'
    });
}]);
