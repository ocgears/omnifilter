'use strict';

// Limits how many image transforms run at once, and how many may wait.
//
// A decoded photo takes width * height * 4 bytes (200 MB at the pixel limit)
// and the GPU runs one job at a time anyway, so only a few transforms run at
// once and the rest wait their turn, first come first served. To keep one
// client from filling the queue, each key (a user id) may have only a few
// transforms waiting or running, and the queue itself has a cap; past either
// limit run() rejects straight away with err.status 429 or 503. A waiting
// transform whose signal aborts (its client went away) leaves the queue
// without running, and run() rejects with err.aborted set.

function queueError(status, msg, extra) {
  return Object.assign(new Error(msg), { status: status }, extra);
}

exports.create = function(options) {
  const maxRunning = options.maxRunning;
  const maxWaiting = options.maxWaiting;
  const maxPerKey = options.maxPerKey;
  const perKeyMessage = options.perKeyMessage ||
    'You already have a photo being processed; wait for it to finish';

  var running = 0;
  const waiting = []; // entries { key, start, cancel }
  const perKey = new Map(); // key -> transforms waiting or running

  const addKey = (key, n) => {
    const count = (perKey.get(key) || 0) + n;
    if (count > 0) perKey.set(key, count);
    else perKey.delete(key);
  };

  // Called once when a running transform finishes: the slot goes straight to
  // the next waiting one, if any.
  function release() {
    const next = waiting.shift();
    if (next) next.start();
    else running--;
  }

  // Resolves or rejects as fn() does, once a slot is free.
  function run(key, fn, signal) {
    if ((perKey.get(key) || 0) >= maxPerKey) {
      return Promise.reject(queueError(429, perKeyMessage, { retryAfter: 2 }));
    }
    if (running >= maxRunning && waiting.length >= maxWaiting) {
      return Promise.reject(queueError(503, 'The server is busy; please try again shortly',
        { retryAfter: 5 }));
    }
    if (signal && signal.aborted) {
      return Promise.reject(queueError(499, 'Request was cancelled', { aborted: true }));
    }

    addKey(key, 1);
    return new Promise((resolve, reject) => {
      var finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        addKey(key, -1);
        release();
      };
      const start = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
        Promise.resolve().then(fn).then(resolve, reject).finally(finish);
      };
      const entry = { key: key, start: start };
      function onAbort() {
        const i = waiting.indexOf(entry);
        if (i < 0) return; // already started; let it finish
        waiting.splice(i, 1);
        addKey(key, -1);
        reject(queueError(499, 'Request was cancelled', { aborted: true }));
      }

      if (running < maxRunning) {
        running++;
        start();
      } else {
        if (signal) signal.addEventListener('abort', onAbort);
        waiting.push(entry);
      }
    });
  }

  return {
    run: run,
    stats: () => ({ running: running, waiting: waiting.length, keys: perKey.size })
  };
};
