'use strict';

// On Cloud Run, a line written to stdout is one log entry, so a stack trace
// would arrive as a dozen, none of them marked as an error. Cloud Logging
// reads a line that's a JSON object as a structured entry instead: this
// makes every console message one, with a severity (console.error and
// "Unexpected error" lines are ERROR, "WARNING" lines are WARNING). The
// server installs it when K_SERVICE is set, as Cloud Run sets it.

const util = require('util');
const { AsyncLocalStorage } = require('async_hooks');

// The trace of the request being handled, if any (see middleware()), so a
// request's log lines show under it in Cloud Logging, beside Cloud Run's
// own line for the request.
const requestTrace = new AsyncLocalStorage();

function severity(message, fallback) {
  if (/^(Unexpected error|Could not connect to MongoDB)/.test(message)) return 'ERROR';
  if (/^WARNING\b/.test(message)) return 'WARNING';
  return fallback;
}

// A console method that writes one JSON line to `out` (stdout by default).
function writer(fallback, out) {
  return function() {
    const message = util.format.apply(null, arguments);
    const entry = { severity: severity(message, fallback), message: message };
    const trace = requestTrace.getStore();
    if (trace) entry['logging.googleapis.com/trace'] = trace;
    (out || process.stdout).write(JSON.stringify(entry) + '\n');
  };
}

// Middleware: what's logged while a request is handled carries its trace,
// from the X-Cloud-Trace-Context header Cloud Run adds ("TRACE_ID/SPAN;o=1"),
// in the projects/PROJECT/traces/TRACE_ID form Cloud Logging links. Needs
// the project's ID (GOOGLE_CLOUD_PROJECT, which deploy.yml sets).
exports.middleware = function(project) {
  return (req, res, next) => {
    const header = req.get('X-Cloud-Trace-Context');
    const id = header && /^([0-9a-f]{32})\b/i.exec(header);
    if (!project || !id) return next();
    requestTrace.run('projects/' + project + '/traces/' + id[1].toLowerCase(), next);
  };
};

exports.install = function(out) {
  console.log = console.info = writer('INFO', out);
  console.warn = writer('WARNING', out);
  console.error = writer('ERROR', out);
};

exports.writer = writer;
