// The Android tests (phone.android.js), run in CI's android job against an
// emulator. The built client must already be in dist/, built with
// OMNIFILTER_API=/ (the page has no init script here to say where the API is).
const { defineConfig } = require('@playwright/test');

const PORT = Number(process.env.E2E_PORT) || 3930;

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: '*.android.js',
  outputDir: '../../test-results/android',
  workers: 1,
  timeout: 180000,
  // Give up on the whole run rather than use up the job's time.
  globalTimeout: 15 * 60000,
  expect: { timeout: 30000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report' }]] : 'list',
  webServer: {
    command: 'node server/server.js',
    cwd: '../..',
    url: 'http://localhost:' + PORT + '/device',
    timeout: 60000,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      MONGOLAB_URI: process.env.E2E_MONGO_URI || 'mongodb://localhost/omnifilter_e2e',
      APP_SECRET: 'e2e-only-secret-not-for-production',
      GUEST_RATE_BURST: '100'
    }
  }
});
