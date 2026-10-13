const angular = require('angular');
require(__dirname + '/../js/client.js');
require('angular-mocks');

// Route changes make ngRoute fetch view templates over $http, which the mock
// $httpBackend rejects. Serve them from $templateCache instead.
angular.module('omnifilterTemplates', []).run(['$templateCache', function($templateCache) {
  $templateCache.put('/views/sign_up_in_view.html', require('../views/sign_up_in_view.html'));
  $templateCache.put('/views/photo_view.html', require('../views/photo_view.html'));
  $templateCache.put('/views/four_oh_four.html', require('../views/four_oh_four.html'));
}]);
beforeEach(angular.mock.module('omnifilterTemplates'));

require(__dirname + '/auth_controller_test');
require(__dirname + '/signin_controller_test');
require(__dirname + '/signup_controller_test');
require(__dirname + '/photos_controller_test');
require(__dirname + '/user_auth_test');
