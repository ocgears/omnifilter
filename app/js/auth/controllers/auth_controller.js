module.exports = function(app) {
  app.controller('authController', ['$scope', '$location', 'userAuth', function($scope, $location, userAuth) {
    $scope.email = null;
    // Set when there's a token but the server couldn't be asked whose it is.
    $scope.unverified = false;

    $scope.updateEmail = function() {
      userAuth.getEmail(function(err, email) {
        $scope.email = err ? null : email || null;
        $scope.unverified = false;
        if (!err) return;
        // A token the server rejects is no use; forget it. If the server
        // couldn't be reached (or failed), keep it and keep logout available.
        if (err.status === 401 || err.status === 403) userAuth.signOut();
        else $scope.unverified = !!userAuth.getToken();
      });
    };

    $scope.logout = function() {
      userAuth.signOut(function() {
        $scope.email = null;
        $scope.unverified = false;
        $location.path('/signin');
      });
    };
  }]);
};
