'use strict';

// Checks for the email and password fields of the account routes.

const MAX_EMAIL_LENGTH = 254;
const MIN_PASSWORD_LENGTH = 8;
// bcrypt only uses the first 72 bytes of a password and ignores the rest.
const MAX_PASSWORD_BYTES = 72;

// something@something.tld, with no spaces and one @. Deliberately loose: the
// only real test of an email address is sending mail to it.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/;

// The email, trimmed and lowercased, or null if it doesn't look like one.
exports.normalizeEmail = (value) => {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= MAX_EMAIL_LENGTH && EMAIL.test(email) ? email : null;
};

// What's wrong with a new password, or null if it will do.
exports.passwordProblem = (value) => {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH) {
    return 'Please enter a password longer than 7 characters';
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) {
    return 'Passwords can be at most ' + MAX_PASSWORD_BYTES + ' bytes long';
  }
  return null;
};

exports.EMAIL_MESSAGE = 'Please enter a valid email address';
