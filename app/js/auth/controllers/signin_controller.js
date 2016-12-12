module.exports = function(app) {
  app.controller('SigninController',
  ['$scope', '$location', 'userAuth', function($scope, $location, auth) {
    $scope.submit = function(user) {
      if (!user) return console.log('No information in the user object when calling submit!');
      auth.signIn(user, function(err) {
        if (err) return console.log('Error in signing in user : ' + err);
        $scope.updateEmail();
        $location.path('/home');
      });
    };
  }]);
};
