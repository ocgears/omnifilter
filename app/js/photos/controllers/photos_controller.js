var angular = require('angular');

module.exports = function(app) {
  app.controller('PhotosController', ['$scope', '$http', 'cfResource',
  function($scope, $http, Resource) {
    $scope.photos = [];
    $scope.newPhoto = {};
    $scope.errors = [];
    var photoService = Resource('/');

    $scope.dismissError = function(err) {
      $scope.errors.splice($scope.errors.indexOf(err), 1);
    };

    $scope.toggleEdit = function(photo) {
      if (photo.backup) {
        var temp = photo.backup;
        $scope.photos.splice($scope.photos.indexOf(photo), 1, temp);
      } else {
        photo.backup = angular.copy(photo);
        photo.editing = true;
      }
    };

    $scope.getAll = function() {
      photoService.getAll(function(err, res) {
        if (err) return console.log(err);
        $scope.photos = res;
      });
    };

    $scope.create = function(photo) {
      alert('OMFG');
      $scope.photos.push(photo);
      photoService.verify(function(res){
        if(!res.content) return console.log('res error' + res);
        console.log('res.content is : ' + res.content);
        photo.user_id = res.content.user._id;

        photoService.create(photo, function(err, res) {
          if (err) {
            $scope.photos.splice($scope.photos.indexOf(photo), 1);
            $scope.errors.push('Could not save photo with name of ' + photo.name);
            return console.log('quiting out the photoService.create with err: ' + err);
          }
          $scope.photos.splice($scope.photos.indexOf(photo), 1, res);
          $scope.newPhoto = null;
        });

      });
      // photo.user_id = $scope.user_id;


    };

    $scope.deletePhoto = function(photo) {
      if (!photo._id) return setTimeout(function() {$scope.deletePhoto(photo);}, 1000);
      photoService.delete(photo, function(err, res) {
        if (err) {
          $scope.errors.push('could not delete photo ' + photo.name);
          return console.log(err);
        }
        $scope.photos.splice($scope.photos.indexOf(photo), 1);
      });
    };

    $scope.updatePhoto = function(photo) {
      photoService.update(photo, function(err, res) {
        photo.editing = false;
        photo.backup = null;
        if (err) {
          $scope.errors.push('could not update photo ' + photo.name);
          return console.log(err);
        }
      });
    };
  }]);
};
