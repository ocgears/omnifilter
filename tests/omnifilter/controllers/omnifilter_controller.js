var angular = require('angular');

module.exports = function(app) {
  app.controller('OmnifilterController', ['$scope', '$http', 'cfResource',
  function($scope, $http, Resource) {
    $scope.omnifilter = [];
    var omnifilterservice = Resource('/');

    $scope.toggleEdit = function(omnifilter) {
      if (omnifilter.backup) {
        var temp = omnifilter.backup;
        $scope.omnifilter.splice($scope.omnifilter.indexOf(omnifilter), 1, temp);
      } else {
        omnifilter.backup = angular.copy(omnifilter);
        omnifilter.editing = true;
      }
    };

    $scope.getAll = function() {
      omnifilterservice.getAll(function(err, res) {
        if (err) return console.log('get all error : ' + err);
        $scope.omnifilter = res;
      });
    };

    $scope.createOmnifilter = function(omnifilter) {
      $scope.omnifilter.push(omnifilter);
      omnifilterservice.create(omnifilter, function(err, res) {
        if (err) return console.log('create error : ' + err);
        $scope.omnifilter.splice($scope.omnifilter.indexOf(omnifilter), 1, res);
        $scope.newOmnifilter = null;
      });
    };

    $scope.deleteOmnifilter = function(omnifilter) {
      if (!omnifilter._id) return setTimeout(function() {$scope.deleteOmnifilter(omnifilter);}, 1000);
      omnifilterservice.delete(omnifilter, function(err, res) {
        if (err) return console.log('delete error : ' + err);
        $scope.omnifilter.splice($scope.omnifilter.indexOf(omnifilter), 1);
      });
    };

    $scope.updateOmnifilter = function(omnifilter) {
      omnifilterservice.update(omnifilter, function(err, res) {
        omnifilter.editing = false;
        omnifilter.backup = null;
        if (err) return console.log('update error : ' + err);
      });
    };
  }]);
};
