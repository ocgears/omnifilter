module.exports = function(app) {
  app.directive('photo', function() {
    return {
      restrict: 'E',
      replace: true,
      transclude: true,
      templateUrl: '/templates/photos/directives/photo.html',
      scope: {
        photoData: '='
      }
    };
  });
};
