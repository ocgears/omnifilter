'use strict';

// A small in-memory rate limiter: a token bucket per client. Each bucket
// holds up to `burst` requests and refills at `perMinute`. When it's empty the
// request gets a 429 with Retry-After. This is per process, so with several
// server processes each keeps its own count.
//
// Clients are told apart by IP address, or by options.key(req) (a user id,
// say). req.ip is the socket address unless the app has been told to trust a
// proxy (app.set('trust proxy', ...)), in which case Express takes it from
// X-Forwarded-For. An IPv6 address counts by its /64 network: one home or
// phone connection is given a whole /64, so it could otherwise use a fresh
// address for every request.

const net = require('net');

// The /64 network an IPv6 address is in, like '2001:db8:1:2::/64'; any other
// address as it is (IPv4, also when written as ::ffff:1.2.3.4).
function clientKey(address) {
  if (!net.isIPv6(address)) return address;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1];
  const halves = address.split('%')[0].split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  // An embedded IPv4 address (::1.2.3.4) is the last 32 bits, so it never
  // reaches the first 64.
  const groups = head.concat(new Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), tail);
  return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':') + '::/64';
}

module.exports = exports = function rateLimit(options) {
  const keyOf = options.key ||
    ((req) => clientKey(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'));
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
    const key = keyOf(req);
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

exports.clientKey = clientKey;
