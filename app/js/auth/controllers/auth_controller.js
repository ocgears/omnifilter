module.exports = function(app) {
  app.controller('authController',
  ['$scope', '$location', 'userAuth', function($scope, $location, userAuth) {
    $scope.email = null;

    $scope.updateEmail = function() {
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
