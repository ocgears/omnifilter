var angular = require('angular');

module.exports = function(app) {
  app.controller('UsersController', ['$scope', '$http', 'cfResource',
  function($scope, $http, Resource) {
    $scope.users = [];
    var userService = Resource('/users');

    $scope.toggleEdit = function(user) {
      if (user.backup) {
        var temp = user.backup;
        $scope.users.splice($scope.users.indexOf(user), 1, temp);
      } else {
        user.backup = angular.copy(user);
        user.editing = true;
      }
    };

    $scope.getAll = function() {
      userService.getAll(function(err, res) {
        if (err) return console.log(err);
        $scope.users = res;
      });
    };

    $scope.createUser = function(user) {
      $scope.users.push(user);
      userService.create(user, function(err, res) {
        if (err) return console.log(err);
        $scope.users.splice($scope.users.indexOf(user), 1, res);
        $scope.newUser = null;
      });
    };

    $scope.deleteUser = function(user) {
      if (!user._id) return setTimeout(function() {$scope.deleteUser(user);}, 1000);
      userService.delete(user, function(err, res) {
        if (err) return console.log(err);
        $scope.users.splice($scope.users.indexOf(user), 1);
      });
    };

    $scope.updateUser = function(user) {
      userService.update(user, function(err, res) {
        user.editing = false;
        user.backup = null;
        if (err) return console.log(err);
      });
    };
  }]);
};
