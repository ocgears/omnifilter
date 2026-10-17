#!/usr/bin/env node
// Builds or tests the Angular client (client/).
//
//   node scripts/client.js build [--production]   (npm run build / build:prod)
//   node scripts/client.js test [--coverage]      (npm run test:client)
//
// The build goes into dist/, which the API server and clientserver.js serve:
// a development build with source maps, or with --production (or
// NODE_ENV=production) a minified one.
//
// The client is its own npm package, since Angular 22 needs Node 22.22 or
// newer while the server runs on Node 22.13; its packages are installed
// here the first time.
//
// OMNIFILTER_API=<url> (or '/' for the same origin as the page) writes the
// API's address into dist/index.html; see client/src/app/api-base.ts.
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const clientDir = path.join(root, 'client');
const distDir = path.join(root, 'dist');
const command = process.argv[2];
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(cmd, args, env) {
  const result = spawnSync(cmd, args, {
    cwd: clientDir,
    stdio: 'inherit',
    env: Object.assign({}, process.env, env),
    shell: process.platform === 'win32'
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 22)) {
  console.error('The client needs Node 22.22 or newer to build (this is ' + process.version + ').');
  process.exit(1);
}

if (!fs.existsSync(path.join(clientDir, 'node_modules', '@angular', 'core'))) {
  console.log('Installing the client\'s packages (client/node_modules)...');
  run(npm, ['ci', '--no-audit', '--no-fund']);
}

const env = { NG_CLI_ANALYTICS: 'false' };
// Angular compiles Sass with sass-embedded, whose Dart binary needs macOS 14
// (Darwin 23); on older macOS it hangs, so use the pure JavaScript compiler.
if (process.platform === 'darwin' && parseInt(os.release(), 10) < 23) {
  env.NG_BUILD_SASS_EMBEDDED = '0';
}

if (command === 'test') {
  // With --coverage, client/coverage/omnifilter/coverage-summary.json too.
  const coverage = process.argv.includes('--coverage') ?
    ['--coverage', '--coverage-reporters=json-summary', '--coverage-reporters=text-summary'] : [];
  run(npm, ['exec', '--', 'ng', 'test', '--watch=false'].concat(coverage), env);
  process.exit(0);
}
if (command !== 'build') {
  console.error('Usage: node scripts/client.js build [--production] | test');
  process.exit(1);
}

// A clean dist/, so no files from an older build linger.
fs.rmSync(distDir, { recursive: true, force: true });
run(npm, ['exec', '--', 'ng', 'build', '--configuration', production ? 'production' : 'development'], env);

const api = process.env.OMNIFILTER_API;
if (api !== undefined) {
  const index = path.join(distDir, 'index.html');
  const attr = api.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const html = fs.readFileSync(index, 'utf8').replace(/(<meta charset="utf-8">)/i,
    '$1\n  <meta name="omnifilter-api" content="' + attr + '">');
  fs.writeFileSync(index, html);
  console.log('The client calls the API at ' + (api.replace(/\/+$/, '') || 'the page\'s own address') + '.');
}
