var PORT = process.env.PORT || process.env.$PORT || 3000;
var clientPort = process.env.CLIENTPORT || 5000;
var hostURL = process.env.HOSTURL || 'http://localhost:';
const express = require('express');
const app = module.exports = exports = express();
const mongoose = require('mongoose');
// Treat query values as plain values, never as operators like $ne, even if a
// route forgets to check what it was sent.
mongoose.set('sanitizeFilter', true);
mongoose.connect(process.env.MONGOLAB_URI || 'mongodb://localhost/omnifilter_app_dev')
  .catch((err) => console.log('Could not connect to MongoDB: ' + err.message));

// The web pages allowed to call the API from a browser: CORS_ORIGINS, a
// comma-separated list such as "https://omnifilter.example,http://localhost:5000",
// or else the client server's address.
const corsOrigins = (process.env.CORS_ORIGINS || hostURL + clientPort)
  .split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.vary('Origin');
  if (origin && corsOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, token');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    res.header('Access-Control-Max-Age', '600');
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

const contentRouter = require(__dirname + '/routes/content_routes');
const authRouter = require(__dirname + '/routes/auth_routes');
const userRouter = require(__dirname + '/routes/user_routes');

app.use('/', contentRouter);
app.use('/', authRouter);
app.use('/', userRouter);

// The built client (`npm run build` puts it in dist/), when there is one, so
// the API and the pages can be served from one place.
const clientDir = require('path').join(__dirname, '..', 'dist');
if (require('fs').existsSync(clientDir)) app.use(express.static(clientDir));

// Errors passed on by the routes, including unreadable or oversized request
// bodies, get a short JSON reply instead of an HTML page with a stack trace.
app.use((err, req, res, next) => {
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.log('Unexpected error: ', err);
  if (res.headersSent) return next(err);
  res.status(status).json({ msg: status === 500 ? 'Server Error' : err.message });
});

// Sets up the device now (OpenCL compiles its kernels here; WebGPU in the
// background), and says what the filters will run on.
const gpuFilters = require(__dirname + '/lib/gpu_filters');
gpuFilters.ready().then(() => {
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
}, (e) => {
  console.log('WARNING: image filters will fail: ' + e.message);
});

app.listen(PORT, () => console.log('Omnifilter backend server up on port: ' + PORT));
