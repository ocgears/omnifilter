// Base64 of the UTF-8 bytes of a string. btoa alone only takes Latin-1 (and
// throws on anything past U+00FF, like '€'), while the server decodes the
// Basic auth header as UTF-8.
function base64Utf8(str) {
  var bytes = new TextEncoder().encode(str);
  var binary = '';
  for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

module.exports = function(app) {
  app.factory('userAuth', ['$http', '$window', 'apiBase', function($http, $window, apiBase) {
    var token;
    var user;
    var auth = {
      createUser: function(user, cb) {
        cb = cb || function() {};
        $http.post(apiBase + '/signup', user)
          .then(function(res) {
            token = $window.localStorage.token = res.data.token;
            cb(null);
          }, function(res) {
            console.log('createUser fail promise, res status : ' + res.status);
            cb(res);
          });
      },
      signIn: function(user, cb) {
        cb = cb || function() {};
        $http({
          method: 'GET',
          url: apiBase + '/signin',
          headers: {
            'Authorization': 'Basic ' + base64Utf8(user.email + ':' + user.password)
          }
        })
          .then(function(res) {
            token = $window.localStorage.token = res.data.token;
            cb(null);
          }, function(res) {
            cb(res);
          });
      },
      getToken: function() {
        token = token || $window.localStorage.token;
        return token;
      },
      signOut: function(cb) {
        $window.localStorage.removeItem('token');
        token = null;
        user = null;
        cb = cb || function() {};
        cb();
      },
      // Calls back with (err, email). err is the failed response, whose status
      // is 401 when the token is missing or no longer valid, and -1 (no
      // response at all) when the API can't be reached.
      getEmail: function(cb) {
        cb = cb || function() {};
        $http({
          method: 'GET',
          url: apiBase + '/verify',
          headers: {
            token: auth.getToken()
          }
        })
        .then(function(res) {
          user = res.data && res.data.email;
          cb(null, user);
        }, function(res) {
          user = null;
          cb(res || { status: -1 });
        });
      },
      user: function() {
        if (!user) auth.getEmail();
        return user;
      }
    };
    return auth;
  }]);
};

module.exports.base64Utf8 = base64Utf8;
