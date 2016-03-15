module.exports = function(app) {
  app.directive('user', function() {
    return {
      restrict: 'E',
      replace: true,
      transclude: true,
      templateUrl: '/templates/users/directives/user.html',
      scope: {
        userData: '='
      }
    };
  });
};
