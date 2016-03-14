const angular = require('angular');
require('angular-route');
const omnifilterApp = angular.module('omnifilterApp', ['ngRoute']);

require('./services')(omnifilterApp);

// require('./omnifilter')(omnifilterApp);
require('./auth')(omnifilterApp);
require('./photos')(omnifilterApp);
// require('./users')(omnifilterApp);

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
