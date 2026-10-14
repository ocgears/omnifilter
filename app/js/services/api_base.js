// Where the API lives, used for every request the client makes.
//
// By default it's port 3000 on the host that served the page, which is how
// `npm start` and docker-compose.yml run it. To point the client somewhere
// else, set either of these in index.html before bundle.js loads:
//   <script>window.OMNIFILTER_API = 'https://api.example.com';</script>
//   <meta name="omnifilter-api" content="https://api.example.com">
// (`OMNIFILTER_API=... npm run build` writes the meta tag for you.) An empty
// value or '/' means the API is on the same origin as the page, for when the
// API server also serves the client.
function apiBaseFrom(win) {
  var override = win.OMNIFILTER_API;
  if (override === undefined || override === null) {
    var meta = win.document.querySelector('meta[name="omnifilter-api"]');
    override = meta ? meta.getAttribute('content') : null;
  }
  if (override !== undefined && override !== null) {
    return String(override).trim().replace(/\/+$/, '');
  }
  return win.location.protocol + '//' + win.location.hostname + ':3000';
}

module.exports = function(app) {
  app.factory('apiBase', ['$window', apiBaseFrom]);
};

module.exports.apiBaseFrom = apiBaseFrom;
