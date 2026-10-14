var angular = require('angular');

module.exports = function(app) {
  app.controller('PhotosController', ['$scope', '$http', 'ocResource', function($scope, $http, Resource) {
    $scope.photos = [];
    $scope.newPhoto = {};
    $scope.errors = [];
    $scope.serverMessages = [];
    $scope.filters = [];
    $scope.presets = [];
    // Until the filter list arrives, presets can't be checked against it.
    $scope.filtersLoaded = false;
    $scope.maxLayers = 8;
    // Filters are applied top to bottom, each laid over the result of the
    // ones above with its strength and blend mode. tOption is null (not '')
    // so a layer's select shows its "None" option.
    $scope.layers = [newLayer()];
    // On an object so the preset select (inside an ng-if) can set it.
    $scope.selection = { preset: null };
    var photoService = Resource('/');

    function newLayer() {
      return { tOption: null, params: {}, amount: 100, blend: 'normal' };
    }

    function findFilter(name) {
      return $scope.filters.find(function(f) {
        return f.name === name;
      });
    }

    $scope.getFilters = function() {
      photoService.getFilters(function(err, res) {
        if (err) return $scope.errors.push('Could not load the list of filters.');
        // Hide filters the server's GPU can't run.
        $scope.filters = res.filter(function(f) {
          return f.available !== false;
        });
        $scope.filtersLoaded = true;
        // Layers filled in before the list arrived (say, from a preset) get
        // the defaults for whatever settings they didn't give.
        $scope.layers.forEach(function(layer) {
          if (layer.tOption) resetParams(layer, layer.params);
        });
        var preset = $scope.selectedPreset();
        if (preset && $scope.missingFilters(preset).length) {
          $scope.errors.push(missingMessage(preset));
          $scope.selection.preset = null;
        }
      });
      photoService.getDevice(function(err, res) {
        $scope.device = err ? null : res;
      });
      photoService.getPresets(function(err, res) {
        if (err) return $scope.errors.push('Could not load the preset looks.');
        $scope.presets = res.presets;
        $scope.maxLayers = res.maxLayers;
        $scope.blendModes = res.layerParams.find(function(p) {
          return p.name === 'blend';
        }).options;
      });
    };

    $scope.layerFilter = function(layer) {
      return findFilter(layer.tOption);
    };

    $scope.filterLabel = function(name) {
      var filter = findFilter(name);
      return filter ? filter.label : (name || 'Original');
    };

    // What a saved photo had applied, e.g. "Sepia + Vignette".
    $scope.photoLabel = function(photo) {
      if (photo.tStack && photo.tStack.length) {
        return photo.tStack.map(function(layer) {
          return $scope.filterLabel(layer.tOption);
        }).join(' + ');
      }
      return $scope.filterLabel(photo.tOption);
    };

    // Each filter starts from its default settings, plus any given. Before
    // the filter list has loaded, the given settings are kept as they are.
    function resetParams(layer, given) {
      var filter = findFilter(layer.tOption);
      if (!filter) {
        layer.params = angular.copy(given || {});
        return;
      }
      layer.params = {};
      filter.params.forEach(function(p) {
        layer.params[p.name] = given && given[p.name] !== undefined ? given[p.name] : p.default;
      });
    }

    // Any change to the stack means it's no longer the selected preset.
    $scope.stackEdited = function() {
      $scope.selection.preset = null;
    };

    $scope.layerFilterChanged = function(layer) {
      resetParams(layer);
      $scope.stackEdited();
    };

    $scope.addLayer = function() {
      if ($scope.layers.length < $scope.maxLayers) {
        $scope.layers.push(newLayer());
        $scope.stackEdited();
      }
    };

    $scope.removeLayer = function(index) {
      $scope.layers.splice(index, 1);
      if (!$scope.layers.length) $scope.layers.push(newLayer());
      $scope.stackEdited();
    };

    $scope.moveLayer = function(index, by) {
      var to = index + by;
      if (to < 0 || to >= $scope.layers.length) return;
      var layer = $scope.layers.splice(index, 1)[0];
      $scope.layers.splice(to, 0, layer);
      $scope.stackEdited();
    };

    // The filters a preset uses that this server can't run. Empty until the
    // filter list has loaded.
    $scope.missingFilters = function(preset) {
      if (!$scope.filtersLoaded) return [];
      return preset.stack.map(function(item) {
        return item.tOption;
      }).filter(function(name) {
        return !findFilter(name);
      });
    };

    function missingMessage(preset) {
      return 'The ' + preset.label + ' preset needs filters this server can\'t run: ' +
        $scope.missingFilters(preset).join(', ') + '.';
    }

    $scope.presetLabel = function(preset) {
      return preset.label + ($scope.missingFilters(preset).length ? ' (not available here)' : '');
    };

    // Replaces the layers with a preset's, which can then be adjusted.
    $scope.applyPreset = function() {
      var preset = $scope.presets.find(function(p) {
        return p.name === $scope.selection.preset;
      });
      if (!preset) return;
      if ($scope.missingFilters(preset).length) {
        $scope.selection.preset = null;
        return $scope.errors.push(missingMessage(preset));
      }
      $scope.layers = preset.stack.map(function(item) {
        var layer = newLayer();
        layer.tOption = item.tOption;
        layer.amount = item.amount === undefined ? 100 : item.amount;
        layer.blend = item.blend || 'normal';
        resetParams(layer, item.params);
        return layer;
      });
    };

    $scope.selectedPreset = function() {
      return $scope.presets.find(function(p) {
        return p.name === $scope.selection.preset;
      });
    };

    $scope.dismissError = function(err) {
      $scope.errors.splice($scope.errors.indexOf(err), 1);
    };

    $scope.dismissMessage = function(message) {
      $scope.serverMessages.splice($scope.serverMessages.indexOf(message), 1);
    };

    $scope.getAll = function() {
      photoService.getAll((err, res) => {
        if (err) {
          $scope.errors.push('Could not load your photos' +
            (err.data && err.data.msg ? ': ' + err.data.msg : '.'));
          return console.log('err in getAll : ' + err.status);
        }
        $scope.photos = res;
      });
    };

    $scope.createPhoto = function() {
      var filePicked = document.getElementById('file').files[0];
      var readIt = new FileReader();
      // FileReader calls back outside Angular's digest, so $apply makes the
      // error (if any) show up.
      readIt.onloadend = function(e) {
        $scope.$apply(function() {
          var dataFile = e.target.result;
          if (!dataFile) {
            $scope.errors.push('Could not load photo into preview, no data in event. ');
            return console.log('error');
          }
          document.getElementById('preview').src = dataFile;
          window.previewImg = true;
        });
      };
      try {
        readIt.readAsDataURL(filePicked);
      } catch (err) {
        $scope.errors.push('Error in picking the file. ' + err);
      }

    };

    $scope.deletePhoto = function(photo) {
      photoService.delete(photo, function(err, res) {
        if (err) {
          $scope.errors.push('Could not delete photo ' +
            photo._id + ', ' + photo.name);
          return console.log(err);
        }
        $scope.photos.splice($scope.photos.indexOf(photo), 1);
        $scope.serverMessages.push(res);
      });
    };

    $scope.cancelPreview = function() {
      console.log('cancelPreview called.');
      window.previewImg = false;
      document.getElementById('preview').src = '';
    };

    $scope.transformPhoto = function() {
      // img.src resolves '' to the page URL, so check the raw attribute.
      var previewSrc = document.getElementById('preview').getAttribute('src') || '';
      if (previewSrc.indexOf('data:') !== 0) {
        console.log('Image src for preview was not valid');
        return $scope.errors.push('The image source was not valid. Please select via preview.');
      }
      var layers = $scope.layers.filter(function(layer) {
        return layer.tOption;
      });
      var sendObj = { content: previewSrc };
      if (!layers.length) {
        $scope.serverMessages.push({ msg: 'No transformation selected, saving the original image.' });
        sendObj.tOption = '';
      } else if (layers.length === 1 && layers[0].amount >= 100 && layers[0].blend === 'normal') {
        // A single filter at full strength is sent the simple way.
        sendObj.tOption = layers[0].tOption;
        sendObj.params = layers[0].params;
      } else {
        sendObj.stack = layers.map(function(layer) {
          return { tOption: layer.tOption, params: layer.params, amount: layer.amount, blend: layer.blend };
        });
      }

      $scope.transforming = true;
      photoService.create(sendObj, function(err, res) {
        $scope.transforming = false;
        if (err) {
          $scope.errors.push('Could not create photo on server' +
            (err.data && err.data.msg ? ': ' + err.data.msg : '.'));
          return console.log('Error in transformPhoto create.', err);
        }
        $scope.photos.push(res);
      });
    };

  }]);
};
