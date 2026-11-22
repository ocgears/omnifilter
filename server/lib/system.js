'use strict';

// Detects modern vs legacy operating systems and hardware capabilities so
// startup, builds and tests can use faster modern native libraries and GPU
// execution providers when supported, while falling back cleanly on older
// machines (such as Intel Macs running macOS 12 Monterey / Darwin 21).

const os = require('os');

// Returns the Darwin kernel major version on macOS (e.g. 21 for macOS 12
// Monterey, 22 for macOS 13 Ventura, 23 for macOS 14 Sonoma, 25 for
// macOS 26 Tahoe), or null on other platforms.
function darwinMajor(platform, release) {
  const plat = platform || process.platform;
  if (plat !== 'darwin') return null;
  const ver = parseInt(release || os.release(), 10);
  return Number.isFinite(ver) ? ver : null;
}

// macOS 12 Monterey (Darwin 21) or older: Playwright has no bundled
// Chromium/Firefox/WebKit builds for it, and modern macOS 13+ native
// binaries and CoreML execution providers do not run there.
function isLegacyMac(platform, release) {
  const major = darwinMajor(platform, release);
  return major !== null && major < 22;
}

// Angular's native Dart sass-embedded binary requires macOS 14 (Darwin 23)
// on macOS (it hangs on Darwin < 23), while Linux and Windows support it.
function supportsNativeSass(platform, release) {
  const major = darwinMajor(platform, release);
  return major === null || major >= 23;
}

// Whether the `webgpu` (Dawn) npm package is installed and its prebuilt
// native binary supports this OS release. Dawn 0.3+ macOS binaries target
// macOS 26 (Darwin 25), whereas Dawn 0.2 runs on macOS 12+ (Darwin 21+).
function supportsDawn(options) {
  options = options || {};
  const resolve = options.resolve || ((id) => require.resolve(id));
  try {
    resolve('webgpu');
  } catch (e) {
    return false;
  }
  const major = darwinMajor(options.platform, options.release);
  if (major === null) return true;
  var version = options.version;
  if (!version) {
    try {
      version = require('webgpu/package.json').version;
    } catch (e) {
      version = '';
    }
  }
  const parts = String(version || '').split('.').map((n) => parseInt(n, 10));
  if (parts[0] > 0 || (parts[0] === 0 && parts[1] >= 3)) {
    return major >= 25;
  }
  return major >= 21;
}

// Chooses which GPU backend ('opencl' or 'webgpu') runs filter plans at
// startup. Explicit OMNIFILTER_BACKEND=opencl or webgpu wins; with 'auto'
// (or unset), uses OpenCL when an OpenCL device is present, and otherwise
// falls back to WebGPU if Dawn is installed and supported on this system.
function selectBackend(env, options) {
  env = env || process.env;
  options = options || {};
  const raw = String(env.OMNIFILTER_BACKEND || '').trim().toLowerCase();
  if (!['', 'auto', 'opencl', 'webgpu'].includes(raw)) {
    throw new Error('OMNIFILTER_BACKEND must be opencl, webgpu or auto, not ' + raw);
  }
  if (raw === 'opencl' || raw === 'webgpu') return raw;
  const hasWebGPU = options.hasWebGPU ? options.hasWebGPU() : false;
  if (!hasWebGPU) return 'opencl';
  const hasOpenCL = options.hasOpenCL ? options.hasOpenCL(raw === 'auto') : false;
  return hasOpenCL ? 'opencl' : 'webgpu';
}

// Chooses ONNX Runtime execution providers for neural style transfer:
// modern systems try bundled hardware providers (CUDA, DirectML, CoreML)
// ahead of CPU, while legacy macOS 12 goes straight to CPU. Returns null
// when `ort` has no `listSupportedBackends` (e.g. a test stub) and no
// explicit OMNIFILTER_ORT_PROVIDERS override is set.
function ortExecutionProviders(ort, options) {
  options = options || {};
  const env = options.env || process.env;
  const configured = String(env.OMNIFILTER_ORT_PROVIDERS || '').split(',')
    .map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (configured.length) return configured;
  if (!ort || typeof ort.listSupportedBackends !== 'function') return null;
  if (isLegacyMac(options.platform, options.release)) return ['cpu'];
  let backends;
  try {
    backends = ort.listSupportedBackends();
  } catch (e) {
    return ['cpu'];
  }
  if (!Array.isArray(backends) || !backends.length) return ['cpu'];
  const supported = new Set(backends
    .filter((b) => b && typeof b.name === 'string' && b.bundled !== false)
    .map((b) => b.name.toLowerCase()));
  const preferred = ['cuda', 'dml', 'coreml'].filter((name) => supported.has(name));
  preferred.push('cpu');
  return preferred;
}

module.exports = {
  darwinMajor: darwinMajor,
  isLegacyMac: isLegacyMac,
  supportsNativeSass: supportsNativeSass,
  supportsDawn: supportsDawn,
  selectBackend: selectBackend,
  ortExecutionProviders: ortExecutionProviders
};
