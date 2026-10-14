// End-to-end tests (`npm run test:e2e`): a real browser drives the built
// client, served by the API server itself, against a real database and the
// OpenCL device, once at desktop size and once as a phone. See e2e/.
const os = require('os');
const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.E2E_PORT) || 3930;

// Playwright has no Chromium build for macOS 12 (Darwin 21) or older, so use
// the installed Google Chrome there.
const oldMac = process.platform === 'darwin' && parseInt(os.release(), 10) < 22;

// WebGPU, for the live preview (e2e/gpu.spec.js). Chrome has it on macOS and
// Windows; on Linux it's behind a flag, and machines without a GPU (CI) use
// SwiftShader, Chrome's software GPU, through the full Chromium build.
const browser = oldMac ? { channel: 'chrome' } : process.platform === 'linux' ? {
  channel: 'chromium',
  launchOptions: {
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader',
      '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader']
  }
} : {};

module.exports = defineConfig({
  testDir: 'e2e',
  globalSetup: require.resolve('./e2e/global_setup'),
  // The tests share one account's photos, so they run in order.
  workers: 1,
  fullyParallel: false,
  // Filters run on the CPU in CI, which is slower.
  timeout: 60000,
  expect: { timeout: 20000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:' + PORT,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    { name: 'desktop', use: Object.assign({}, devices['Desktop Chrome'], browser) },
    // A phone-sized touch screen (Chromium, as Playwright's iPhones need
    // WebKit). The WebGPU comparisons don't depend on the screen.
    { name: 'phone', use: Object.assign({}, devices['Pixel 7'], browser), testIgnore: /gpu\.spec/ }
  ],
  webServer: {
    // Builds the client into dist/ (installing its packages the first time),
    // which the API serves when it exists.
    command: 'npm run build && node server/server.js',
    url: 'http://localhost:' + PORT + '/device',
    timeout: 180000,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      MONGOLAB_URI: process.env.E2E_MONGO_URI || 'mongodb://localhost/omnifilter_e2e',
      APP_SECRET: 'e2e-only-secret-not-for-production',
      AUTH_RATE_BURST: '100'
    }
  }
});
