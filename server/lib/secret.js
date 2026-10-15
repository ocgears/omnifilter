'use strict';

// The key that signs login tokens. Anyone who knows it can forge a token for
// any account, so there is no built-in default. Set APP_SECRET to a long
// random string (e.g. `openssl rand -hex 32`); without it a random key is
// generated at startup, which is secure but signs everyone out on restart.

const crypto = require('crypto');

var secret = process.env.APP_SECRET;
if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  if (process.env.NODE_ENV !== 'test') {
    console.log('APP_SECRET is not set, so logins will end when the server restarts.');
  }
} else if (secret.length < 32) {
  console.log('WARNING: APP_SECRET is short. Use at least 32 random characters.');
}

module.exports = exports = secret;
