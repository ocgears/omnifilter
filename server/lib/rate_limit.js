'use strict';

// A small in-memory rate limiter: a token bucket per client IP. Each bucket
// holds up to `burst` requests and refills at `perMinute`. When it's empty the
// request gets a 429 with Retry-After. This is per process, so with several
// server processes each keeps its own count.
//
// req.ip is the socket address unless the app has been told to trust a proxy
// (app.set('trust proxy', ...)), in which case Express takes it from
// X-Forwarded-For.

module.exports = exports = function rateLimit(options) {
  const perMinute = options.perMinute;
  const burst = options.burst;
  const message = options.message || 'Too many requests, please try again later';
  const now = options.now || Date.now;
  const ratePerMs = perMinute / 60000;
  const buckets = new Map();

  // A bucket that has refilled completely is the same as no bucket, so drop
  // those now and then; the map then only holds recently active clients.
  const fullAfterMs = burst / ratePerMs;
  var lastPrune = now();
  function prune(t) {
    if (t - lastPrune < 60000) return;
    lastPrune = t;
    for (const [key, bucket] of buckets) {
      if (t - bucket.updated >= fullAfterMs) buckets.delete(key);
    }
  }

  const limiter = (req, res, next) => {
    const t = now();
    prune(t);
    const key = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    var bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: burst, updated: t };
      buckets.set(key, bucket);
    } else {
      bucket.tokens = Math.min(burst, bucket.tokens + (t - bucket.updated) * ratePerMs);
      bucket.updated = t;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return next();
    }
    res.set('Retry-After', String(Math.max(1, Math.ceil((1 - bucket.tokens) / ratePerMs / 1000))));
    res.status(429).json({ msg: message });
  };

  limiter.size = () => buckets.size;
  limiter.reset = () => buckets.clear();
  return limiter;
};
