'use strict';

// On Cloud Run, a line written to stdout is one log entry, so a stack trace
// would arrive as a dozen, none of them marked as an error. Cloud Logging
// reads a line that's a JSON object as a structured entry instead: this
// makes every console message one, with a severity (console.error and
// "Unexpected error" lines are ERROR, "WARNING" lines are WARNING). The
// server installs it when K_SERVICE is set, as Cloud Run sets it.

const util = require('util');

function severity(message, fallback) {
  if (/^(Unexpected error|Could not connect to MongoDB)/.test(message)) return 'ERROR';
  if (/^WARNING\b/.test(message)) return 'WARNING';
  return fallback;
}

// A console method that writes one JSON line to `out` (stdout by default).
function writer(fallback, out) {
  return function() {
    const message = util.format.apply(null, arguments);
    (out || process.stdout).write(JSON.stringify({ severity: severity(message, fallback), message: message }) +
      '\n');
  };
}

exports.install = function(out) {
  console.log = console.info = writer('INFO', out);
  console.warn = writer('WARNING', out);
  console.error = writer('ERROR', out);
};

exports.writer = writer;
