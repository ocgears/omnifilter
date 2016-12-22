module.exports = function(app) {
  app.directive('photoForm', function() {
    return {
      restrict: 'EAC',
      replace: true,
      transclude: true,
      templateUrl: '/templates/photos/directives/photo_form_directive.html',
      scope: {
        buttonText: '@',
        photo: '=',
        save: '&'
      },
      controller: function($scope) {
        $scope.photo = $scope.photo || null;
      }
    };
  });
};
