// Lighthouse's mobile audit of the built app (CI's lighthouse job):
//   OMNIFILTER_API=/ npm run build:prod && npx @lhci/cli autorun
// Lighthouse's default settings stand in for a mid-range phone on a slow 4G
// connection. The photo page (the start page) is audited 3 times and the
// middle run is judged. (The sign-in page is the same URL to Lighthouse, as
// the app's pages differ only after the #.) The budgets are set a little
// below the first results, so they catch regressions without failing on
// run-to-run noise.
// The server started below reads PORT too.
const PORT = process.env.PORT = process.env.PORT || '3940';
const app = 'http://localhost:' + PORT + '/';
// Or a deployed copy, with LHCI_URL=<its address> (the deploy workflow),
// starting no server.
const deployed = process.env.LHCI_URL;
const server = {
  startServerCommand: 'node server/server.js',
  startServerReadyPattern: 'server up on port',
  startServerReadyTimeout: 60000
};

module.exports = {
  ci: {
    collect: Object.assign(deployed ? {} : server, {
      url: [deployed || app],
      numberOfRuns: 3,
      settings: {
        // The runner's Chrome can't use its sandbox (Ubuntu 24.04's AppArmor
        // rules), and the audit doesn't need it.
        chromeFlags: '--no-sandbox --headless=new'
      }
    }),
    assert: {
      assertions: {
        'categories:performance': ['error', { minScore: 0.6, aggregationMethod: 'median-run' }],
        'categories:accessibility': ['error', { minScore: 1, aggregationMethod: 'median-run' }],
        'categories:best-practices': ['error', { minScore: 0.95, aggregationMethod: 'median-run' }],
        'categories:seo': ['error', { minScore: 0.9, aggregationMethod: 'median-run' }],
        'first-contentful-paint': ['warn', { maxNumericValue: 2500, aggregationMethod: 'median-run' }],
        'largest-contentful-paint': ['warn', { maxNumericValue: 4000, aggregationMethod: 'median-run' }],
        'total-blocking-time': ['warn', { maxNumericValue: 1200, aggregationMethod: 'median-run' }],
        'cumulative-layout-shift': ['error', { maxNumericValue: 0.1, aggregationMethod: 'median-run' }],
        'uses-text-compression': 'error'
      }
    },
    upload: {
      // Kept as files (and a workflow artifact), not sent anywhere.
      target: 'filesystem',
      outputDir: 'lighthouse-report'
    }
  }
};
