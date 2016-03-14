module.exports = function(app) {
  app.controller('authController', ['$scope', '$location', 'userAuth', function($scope, $location, userAuth) {
    $scope.email = null;

    $scope.updateEmail = function() {
      // If we are at the signup/in route, the user email is not known, so return.
      // if($location.path() == '/signin' || $location.path() == '/signup') return null;
      userAuth.getEmail(function(res) {
        $scope.email = res.data.email;
      });
    };

    $scope.logout = function() {
      userAuth.signOut(function() {
        $scope.email = null;
        $location.path('/signin');
      });
    };
  }]);
};
