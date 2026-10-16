// The smoke test of a deployed copy of the hosted demo (deployed.smoke.js):
//
//   SMOKE_URL=https://omnifilter-....run.app npx playwright test -c e2e/smoke
//
// It starts no servers: SMOKE_URL is where the copy runs. The deploy
// workflow runs it against each new revision before it gets visitors, and
// nightly against the live site.
const os = require('os');
const { defineConfig, devices } = require('@playwright/test');

if (!process.env.SMOKE_URL) throw new Error('Set SMOKE_URL to the address to test.');

// Chrome's WebGPU, as in ../../playwright.config.js: on Linux machines
// without a GPU (CI), through SwiftShader; the installed Chrome on macOS 12.
let browser = {};
if (process.platform === 'darwin' && parseInt(os.release(), 10) < 22) browser = { channel: 'chrome' };
if (process.platform === 'linux') {
  browser = {
    channel: 'chromium',
    launchOptions: {
      args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader',
        '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader']
    }
  };
}

module.exports = defineConfig({
  testDir: '.',
  testMatch: '*.smoke.js',
  workers: 1,
  // A copy that has scaled to zero starts up for the first request.
  timeout: 120000,
  expect: { timeout: 30000 },
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: Object.assign({}, devices['Desktop Chrome'], browser, {
    baseURL: process.env.SMOKE_URL.replace(/\/+$/, ''),
    trace: 'retain-on-failure'
  })
});
