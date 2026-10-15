// Waits until the client has been built into dist/ (by the first web server
// in playwright.config.js, which builds it), for a second server to serve it.
const fs = require('fs');
const path = require('path');

const index = path.join(__dirname, '..', 'dist', 'index.html');
const started = Date.now();
(function wait() {
  if (fs.existsSync(index)) process.exit(0);
  if (Date.now() - started > 170000) {
    console.error('No build in dist/ after 170 s');
    process.exit(1);
  }
  setTimeout(wait, 500);
})();
