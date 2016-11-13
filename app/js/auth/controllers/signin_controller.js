module.exports = function(app) {
  app.controller('SigninController',
  ['$scope', '$location', 'userAuth', function($scope, $location, auth) {
    $scope.submit = function(user) {
      auth.signIn(user, function(err) {
        if (err) return console.log('Error in signing in user : ' + err);
        $scope.updateEmail();
        $location.path('/home');
      });
    };
  }]);
};
