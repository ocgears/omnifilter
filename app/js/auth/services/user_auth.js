module.exports = function(app) {
  app.factory('userAuth', ['$http', '$window', function($http, $window) {
    var token;
    var user;
    var auth = {
      createUser: function(user, cb) {
        cb = cb || function(){};
        $http.post('http://localhost:3000/signup', user)
          .then(function(res) {
            console.log('createUser success promise, res status : ' + res.status);
            token = $window.localStorage.token = res.data.token;
            cb(null);
          }, function(res) {
            console.log('createUser fail promise, res status : ' + res.status);
            cb(res);
          });
      },
      signIn: function(user, cb) {
        cb = cb || function(){};
        $http({
          method: 'GET',
          url: 'http://localhost:3000/signin',
          headers: {
            'Authorization': 'Basic ' + btoa((user.email + ':' + user.password))
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
        $window.localStorage.token = null;
        token = null;
        user = null;
        cb = cb || function(){};
        cb();
      },
      getEmail: function(cb) {
        cb = cb || function(){};
        $http({
          method: 'GET',
          url: 'http://localhost:3000/verify',
          headers: {
            token: auth.getToken()
          }
        })
        .then(function(res) {
          user = res.data.email;
          cb(res);
        },function(res) {
          cb(res);
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
