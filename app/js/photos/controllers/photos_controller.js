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
      console.log('called getAll function');
      photoService.getAll((err, res) => {
        if (err) return console.log('Error in getAll function : ' + err);
        console.log('reply from getAll, results: ' + res.length);
        $scope.photos = res;
      });
    };

    $scope.createPhoto = function() {
      console.log('createPhoto called');
      var filePicked = document.getElementById('file').files[0];
      var readIt = new FileReader();
      readIt.onloadend = function(e) {
        var dataFile = e.target.result;
        if (!dataFile) {
          dataFile = null;
          $scope.errors.push('Could not load photo into preview, no data in event. ');
          return console.log('error');
        }
        document.getElementById('preview').src = dataFile;
        window.previewImg = true;
      };
      try {
        readIt.readAsDataURL(filePicked);
      } catch (err) {
        $scope.errors.push('Error in picking the file. ' + err);
      }

    };

    $scope.deletePhoto = function(photo) {
      if (!photo._id) return setTimeout(function() {$scope.deletePhoto(photo);}, 1000);
      photoService.delete(photo, function(err, res) {
        if (err) {
          $scope.errors.push('could not delete photo ' + photo.name);
          return console.log(err);
        }
        $scope.photos.splice($scope.photos.indexOf(photo), 1, res);
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
        $scope.photos.splice($scope.photos.indexOf(photo), 1, res);
      });
    };

    $scope.cancelPreview = function() {
      console.log('cancelPreview called.');
      window.previewImg = false;
      document.getElementById('preview').src = '';
    };

    $scope.transformPhoto = function() {
      $scope.tOption = $scope.tOption || '';
      console.log('transform called called. option selected : ' + $scope.tOption);
      if (!document.getElementById('preview').src) {
        console.log('Image src for preview was not valid');
        return $scope.errors.push('The image source was not valid. Please select via preview.');
      }
      var sendObj = {
        content: document.getElementById('preview').src,
        tOption: $scope.tOption
      };

      photoService.create(sendObj, function(err, res) {
        if (err) {
          $scope.errors.push('Could not create photo on server.');
          return console.log('Error in transformPhoto create.' + err);
        }
        $scope.photos.splice(0, 1, res);
      });
    };
  }]);
};
