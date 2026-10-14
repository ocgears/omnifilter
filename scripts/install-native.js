#!/usr/bin/env node
'use strict';

// Installs the native OpenCL addon (run by `npm install`).
//
// CI builds the addon for each platform whenever its source changes and
// publishes the binaries on the repository's "native-prebuilds" release
// (.github/workflows/prebuilds.yml), named by a hash of the source. This
// script downloads the binary that matches this checkout's source, checks
// its SHA-256 and that it loads, and otherwise compiles the addon with
// node-gyp, which needs a C++ compiler and the OpenCL headers.
//
//   OMNIFILTER_BUILD_FROM_SOURCE=1   always compile (also true or yes)
//   OMNIFILTER_PREBUILD_URL=...      where to download from (see DEFAULT_URL)
//   node scripts/install-native.js --key   prints this source's key

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SOURCES = ['native/omnifilter.cpp', 'binding.gyp'];
const DEFAULT_URL = 'https://github.com/ocgears/omnifilter/releases/download/native-prebuilds';
const PLATFORM = process.platform + '-' + process.arch;

// Identifies the native source. Line endings are normalised so a Windows
// checkout gets the same key.
function sourceKey() {
  const hash = crypto.createHash('sha256');
  for (const file of SOURCES) {
    hash.update(file + '\0' + fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n') + '\0');
  }
  return hash.digest('hex').slice(0, 16);
}

const assetName = (key, platform) => 'omnifilter-' + key + '-' + platform + '.node';

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  return Buffer.from(await res.arrayBuffer());
}

// Whether a binary loads here, checked in a child process so a crash can't
// take down the install. Returns null if it does, or the error.
// Only the error's message is reported, not its stack.
function loadError(file) {
  const check = 'try {' +
    'const a = require(' + JSON.stringify(file) + ');' +
    'if (typeof a.filter !== "function" || typeof a.devices !== "function") throw new Error("not the addon");' +
    '} catch (e) { process.stderr.write(String(e && e.message)); process.exit(1); }';
  const result = spawnSync(process.execPath, ['-e', check], { encoding: 'utf8' });
  return result.status === 0 ? null : (result.stderr || result.signal || 'exit code ' + result.status);
}

// Whether OpenCL.dll is where Windows would find it: System32 or the PATH.
function openCLDllPresent() {
  const dirs = [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')]
    .concat((process.env.PATH || '').split(path.delimiter).filter(Boolean));
  return dirs.some((dir) => fs.existsSync(path.join(dir, 'OpenCL.dll')));
}

// A binary that only fails to load because the OpenCL runtime (libOpenCL,
// OpenCL.dll, OpenCL.framework) is missing is still the right one: compiling
// wouldn't help. The error usually names the addon's own path, which
// mustn't count (a checkout in ~/opencl/ would match anything), so that's
// removed first. Windows doesn't say which DLL is missing: it's only OpenCL's
// fault if OpenCL.dll can't be found (otherwise it may be the VC++ runtime).
//   options.file      the addon's path
//   options.platform  process.platform
//   options.dllFound  () => whether OpenCL.dll is present (Windows)
function missingOpenCL(error, options) {
  options = options || {};
  const platform = options.platform || process.platform;
  var message = String(error);
  for (const p of [options.file, options.file && path.dirname(options.file), ROOT]) {
    if (p) message = message.split(p).join('<addon>');
  }
  if (/libOpenCL\.so|OpenCL\.dll|OpenCL\.framework|libOpenCL\.dylib/i.test(message)) return true;
  return platform === 'win32' && /specified module could not be found/i.test(message) &&
    !(options.dllFound || openCLDllPresent)();
}

// Whether OMNIFILTER_BUILD_FROM_SOURCE asks to compile: 1, true or yes.
const wantsSourceBuild = (value) => /^(1|true|yes)$/i.test(String(value || '').trim());

async function tryPrebuilt() {
  const base = (process.env.OMNIFILTER_PREBUILD_URL || DEFAULT_URL).replace(/\/$/, '');
  const name = assetName(sourceKey(), PLATFORM);
  let binary;
  let expected;
  try {
    [binary, expected] = await Promise.all([download(base + '/' + name), download(base + '/' + name + '.sha256')]);
  } catch (e) {
    console.log('omnifilter: no prebuilt addon for ' + PLATFORM + ' (' + e.message + ')');
    return false;
  }
  const actual = crypto.createHash('sha256').update(binary).digest('hex');
  if (expected.toString().trim().split(/\s+/)[0] !== actual) {
    console.log('omnifilter: the prebuilt addon failed its checksum; compiling instead');
    return false;
  }
  const dir = path.join(ROOT, 'prebuilds', PLATFORM);
  const file = path.join(dir, 'omnifilter.node');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, binary);
  const error = loadError(file);
  if (error && missingOpenCL(error, { file: file })) {
    console.log('omnifilter: installed the prebuilt addon for ' + PLATFORM + ', but no OpenCL runtime was found. ' +
      'Filters need one: it comes with GPU drivers, or install pocl.');
    return true;
  }
  if (error) {
    fs.rmSync(file);
    console.log('omnifilter: the prebuilt addon does not load on this system; compiling instead');
    return false;
  }
  console.log('omnifilter: installed the prebuilt addon for ' + PLATFORM);
  return true;
}

function compile() {
  console.log('omnifilter: compiling the native addon');
  // npm puts its bundled node-gyp on the PATH for install scripts.
  const result = spawnSync('node-gyp', ['rebuild'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error('\nomnifilter: compiling the native addon failed. It needs a C++ compiler and the OpenCL ' +
      'headers; see "Requirements" in README.md.');
    process.exit(result.status || 1);
  }
}

async function main() {
  if (process.argv.includes('--key')) return console.log(sourceKey());
  // A local build wins over a prebuilt one (see server/lib/native.js), so
  // drop any stale one first.
  fs.rmSync(path.join(ROOT, 'build'), { recursive: true, force: true });
  if (wantsSourceBuild(process.env.OMNIFILTER_BUILD_FROM_SOURCE) || !(await tryPrebuilt())) compile();
}

module.exports = {
  sourceKey: sourceKey,
  assetName: assetName,
  missingOpenCL: missingOpenCL,
  wantsSourceBuild: wantsSourceBuild
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
