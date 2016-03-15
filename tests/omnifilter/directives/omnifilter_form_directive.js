module.exports = function(app) {
  app.directive('userForm', function() {
    return {
      restrict: 'EAC',
      replace: true,
      transclude: true,
      templateUrl: '/templates/users/directives/user_form_directive.html',
      scope: {
        buttonText: '@',
        user: '=',
        save: '&'
      },
      controller: function($scope) {
        $scope.user = $scope.user || {author: 'author'};
      }
    };
  });
};
