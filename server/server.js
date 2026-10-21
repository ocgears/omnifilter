// On Cloud Run, log lines go out as JSON, one entry each, under the request
// they were logged for (lib/cloud_logging.js).
const cloudLogging = process.env.K_SERVICE ? require(__dirname + '/lib/cloud_logging') : null;
if (cloudLogging) cloudLogging.install();

var PORT = process.env.PORT || process.env.$PORT || 3000;
var clientPort = process.env.CLIENTPORT || 5000;
var hostURL = process.env.HOSTURL || 'http://localhost:';
const express = require('express');
const app = module.exports = exports = express();
if (cloudLogging) app.use(cloudLogging.middleware(process.env.GOOGLE_CLOUD_PROJECT));
const mongoose = require('mongoose');
// Treat query values as plain values, never as operators like $ne, even if a
// route forgets to check what it was sent.
mongoose.set('sanitizeFilter', true);
// Mongoose reconnects by itself only once it has been connected, so the
// first connection is retried here: a server that starts while the database
// can't be reached (a hosted database's access list still being updated,
// say) connects when it can, instead of staying without one until restarted.
function connectDatabase(wait) {
  mongoose.connect(process.env.MONGOLAB_URI || 'mongodb://localhost/omnifilter_app_dev').catch((err) => {
    console.log('Could not connect to MongoDB: ' + err.message +
      '. Trying again in ' + wait / 1000 + ' s.');
    setTimeout(() => connectDatabase(Math.min(wait * 2, 60000)), wait).unref();
  });
}
connectDatabase(5000);

// The web pages allowed to call the API from a browser: CORS_ORIGINS, a
// comma-separated list such as "https://omnifilter.example,http://localhost:5000",
// or else the client server's address.
const corsOrigins = (process.env.CORS_ORIGINS || hostURL + clientPort)
  .split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);

// The built client (`npm run build` puts it in dist/), when there is one, is
// served from here too; see below.
const path = require('path');
const clientDir = path.join(__dirname, '..', 'dist');

// Security headers, with a Content Security Policy for the built client
// (lib/security_headers.js).
app.use(require(__dirname + '/lib/security_headers')(path.join(clientDir, 'index.html')));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.vary('Origin');
  if (origin && corsOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, token, Omnifilter-Recipe');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    res.header('Access-Control-Max-Age', '600');
    res.header('Access-Control-Expose-Headers', 'Omnifilter-Total');
  }
  // Answer preflight requests here; the browser makes the real request next.
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Behind a proxy or load balancer (Heroku's router, nginx), the visitor's
// address comes in X-Forwarded-For. TRUST_PROXY says which proxies to believe,
// as Express's 'trust proxy' setting: a number of hops (Heroku: 1), or
// addresses. Without it, rate limits see the proxy's address for everyone.
if (process.env.TRUST_PROXY) {
  const hops = Number(process.env.TRUST_PROXY);
  app.set('trust proxy', Number.isInteger(hops) ? hops : process.env.TRUST_PROXY);
}

// Replies are compressed (the page's scripts and styles shrink to a third,
// which matters on a phone's connection), except those carrying photos,
// which hardly shrink and would cost the server time. (The gallery's list
// carries only small thumbnails, so it's compressed with the rest.)
const PHOTO_ROUTES = /^\/(newcontent|transform|import|content)\b/;
const compression = require('compression');
app.use(compression({
  filter: (req, res) => !PHOTO_ROUTES.test(req.path) && compression.filter(req, res)
}));

const gpuFilters = require(__dirname + '/lib/gpu_filters');
const settings = require(__dirname + '/lib/settings');

// For uptime checks and the deploy's smoke test: whether the database is
// connected, and the caller's address as the server sees it (so a deploy
// can check TRUST_PROXY: it should be the caller's own public address).
app.get('/health', async (req, res) => {
  // A server that has just started (Cloud Run starts one for the first
  // request after an idle spell) gets a few seconds to finish connecting.
  for (let waited = 0; mongoose.connection.readyState === 2 && waited < 10000; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const database = mongoose.connection.readyState === 1;
  // On a server that filters, a GPU stuck on a filter (see gpu_filters.js)
  // needs a restart, so it's unhealthy too.
  const gpu = settings.serverDevice(settings.read()) ? gpuFilters.health() : undefined;
  const ok = database && gpu !== 'stuck';
  res.set('Cache-Control', 'no-store');
  res.status(ok ? 200 : 503).json({ ok: ok, database: database, gpu: gpu, ip: req.ip });
});

// The routes read req.body, which the body parsers (body-parser 2) leave
// unset for a request without one.
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

const contentRouter = require(__dirname + '/routes/content_routes');
const authRouter = require(__dirname + '/routes/auth_routes');
const userRouter = require(__dirname + '/routes/user_routes');

app.use('/', contentRouter);
app.use('/', authRouter);
app.use('/', userRouter);

// Photos shared to the installed app from other apps go to its service
// worker (client/public/sw.js). One that arrives here, before the service
// worker has started, opens the app without the photo instead of a 404.
app.post('/share-target', (req, res) => res.redirect(303, '/#/home'));

// The built client, when there is one, so the API and the pages can be
// served from one place. Files whose names carry a hash of their contents
// (main-4NR54UZ5.js) never change, so browsers may keep them.
if (require('fs').existsSync(clientDir)) {
  app.use(express.static(clientDir, {
    setHeaders: (res, file) => {
      if (/-[A-Za-z0-9_-]{8}\.(js|css)$/.test(file)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    }
  }));
}

// Errors passed on by the routes, including unreadable or oversized request
// bodies, get a short JSON reply instead of an HTML page with a stack trace.
app.use((err, req, res, next) => {
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.log('Unexpected error: ', err);
  if (res.headersSent) return next(err);
  res.status(status).json({ msg: status === 500 ? 'Server Error' : err.message });
});

// Sets up the device now (OpenCL compiles its kernels here; WebGPU in the
// background), and says what the filters will run on. A server that doesn't
// filter (cloud mode: visitors' own GPUs do) has nothing to set up.
function setUpDevice() {
  if (!settings.serverDevice(settings.read())) {
    console.log('Filters run on visitors\' own devices (OMNIFILTER_MODE=cloud); none run here.');
    return;
  }
  gpuFilters.ready().then(reportDevice, (e) => {
    console.log('WARNING: image filters will fail: ' + e.message);
  });
}

function reportDevice() {
  const device = gpuFilters.deviceInfo();
  for (const failure of device.skipped) console.log('Skipped OpenCL device ' + failure);
  const others = gpuFilters.devices().length - 1;
  const units = device.computeUnits ? ', ' + device.computeUnits + ' compute units' : '';
  console.log('Filters will run on ' + device.type.toUpperCase() + ': ' + device.name +
    ' (' + device.version.trim() + units + ')' +
    (others ? '; ' + others + ' other OpenCL device' + (others > 1 ? 's' : '') +
      ' available, see `npm run devices`' : ''));
  const setting = (process.env.OMNIFILTER_DEVICE || 'auto').toLowerCase();
  if (device.type !== 'gpu' && (setting === 'auto' || setting === 'any')) {
    console.log('WARNING: no usable GPU was found, so filters will be slower.');
  }
}
setUpDevice();

const server = app.listen(PORT, () => console.log('Omnifilter backend server up on port: ' + PORT));

// Cloud Run (and docker stop, and Heroku) sends SIGTERM before stopping the
// server, and waits 10 seconds: stop taking new connections, let the
// requests under way finish, then close the database connection and go.
// A request still running after 8 seconds is cut off.
function shutDown(signal) {
  console.log('Got ' + signal + '; finishing the requests under way, then stopping.');
  setTimeout(() => {
    console.log('Requests still running after 8 s; stopping anyway.');
    process.exit(1);
  }, 8000).unref();
  server.close(() => {
    mongoose.disconnect().finally(() => process.exit(0));
  });
  server.closeIdleConnections();
}
process.once('SIGTERM', shutDown);
process.once('SIGINT', shutDown);
