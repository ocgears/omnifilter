'use strict';

// Loads the native OpenCL addon: the one compiled in this checkout
// (build/Release) if there is one, otherwise a prebuilt binary that
// scripts/install-native.js downloaded into prebuilds/<platform>-<arch>.
// If it can't be loaded (most often because no OpenCL runtime is installed),
// every function throws an error saying so, rather than the server failing
// to start.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

const candidates = [
  path.join(ROOT, 'build', 'Release', 'omnifilter.node'),
  path.join(ROOT, 'build', 'Debug', 'omnifilter.node'),
  path.join(ROOT, 'prebuilds', process.platform + '-' + process.arch, 'omnifilter.node')
];

function unavailable(message) {
  const fail = () => {
    throw new Error(message);
  };
  return { devices: fail, init: fail, deviceInfo: fail, kernels: fail, filter: fail };
}

const found = candidates.find((file) => fs.existsSync(file));
if (!found) {
  module.exports = unavailable('The native addon is not installed; run `npm install` (or `npm run install`) ' +
    'to download or compile it. Looked for:\n  ' + candidates.join('\n  '));
} else {
  try {
    module.exports = require(found);
  } catch (e) {
    module.exports = unavailable('Could not load the native addon (' + e.message.split('\n')[0] + '). ' +
      'Is an OpenCL runtime installed? It comes with GPU drivers, or install pocl.');
  }
}
