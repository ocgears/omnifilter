var handleSuccess = function(callback) {
  return function(res) {
    callback(null, res.data);
  };
};

var handleFailure = function(callback) {
  return function(res) {
    callback(res);
  };
};

module.exports = exports = function(app) {
  app.factory('ocResource', ['$http', '$window', 'userAuth', 'apiBase', function($http, $window, userAuth, apiBase) {
    var Resource = function(resourceName) {
      this.resourceName = resourceName;
    };

    Resource.prototype.getAll = function(callback) {
      $http({
        method: 'GET',
        url: apiBase + this.resourceName + 'getAll',
        headers: {
          token: userAuth.getToken()
        }
      })
        .then(handleSuccess(callback), handleFailure(callback));
    };

    Resource.prototype.getFilters = function(callback) {
      $http({
        method: 'GET',
        url: apiBase + '/filters'
      })
        .then(handleSuccess(callback), handleFailure(callback));
    };

    Resource.prototype.getDevice = function(callback) {
      $http({
        method: 'GET',
        url: apiBase + '/device'
      })
        .then(handleSuccess(callback), handleFailure(callback));
    };

    Resource.prototype.getPresets = function(callback) {
      $http({
        method: 'GET',
        url: apiBase + '/presets'
      })
        .then(handleSuccess(callback), handleFailure(callback));
    };

    Resource.prototype.create = function(data, callback) {
      $http({
        method: 'POST',
        url: apiBase + this.resourceName + 'newcontent',
        data: data,
        headers: {
          token: userAuth.getToken()
        }
      })
        .then(handleSuccess(callback), handleFailure(callback));
    };

    // Only the editable fields; the server ignores everything else.
    Resource.prototype.update = function(data, callback) {
      $http({
        method: 'PUT',
        url: apiBase + this.resourceName + 'preview/' + data._id,
        data: { title: data.title, createdOn: data.createdOn, location: data.location, tags: data.tags },
        headers: {
          token: userAuth.getToken()
        }
      })
        .then(handleSuccess(callback), handleFailure(callback));
    };

    Resource.prototype.delete = function(data, callback) {
      $http({
        method: 'DELETE',
        url: apiBase + this.resourceName + 'delete/' + data._id,
        headers: {
          token: userAuth.getToken()
        }
      })
        .then(handleSuccess(callback), handleFailure(callback));
    };

    Resource.prototype.verify = function(callback) {
      $http({
        method: 'GET',
        url: apiBase + '/verify',
        headers: {
          token: $window.localStorage.token
        }
      })
        .then(handleSuccess(callback), handleFailure(callback));
    };

    return function(resourceName) {
      return new Resource(resourceName);
    };
  }]);
};
