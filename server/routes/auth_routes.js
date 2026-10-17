const express = require('express');
const User = require(__dirname + '/../models/user');
const jsonParser = require('body-parser').json({ limit: '10kb' });
const handleDBError = require(__dirname + '/../lib/handle_db_error');
const basicHTTP = require(__dirname + '/../lib/basic_http');
const rateLimit = require(__dirname + '/../lib/rate_limit');
const validate = require(__dirname + '/../lib/validate');
const settings = require(__dirname + '/../lib/settings');

const authRouter = module.exports = exports = express.Router();

const DUPLICATE_KEY = 11000;

// Sign-ups and sign-ins per client IP: a burst of AUTH_RATE_BURST, then
// AUTH_RATE_PER_MINUTE. Slows down password guessing.
const limiter = authRouter.rateLimiter = rateLimit({
  perMinute: Number(process.env.AUTH_RATE_PER_MINUTE) || 10,
  burst: Number(process.env.AUTH_RATE_BURST) || 5,
  message: 'Too many attempts, please wait a minute and try again'
});

// Accounts made per day from one address (OMNIFILTER_SIGNUPS_PER_DAY; an
// IPv6 address counts by its /48), so that one client can't make enough of
// them to fill the database with each one's photos. Only sign-ups that
// make an account count.
var dailySignups = null;
function signupsPerDay(req, res, next) {
  const perDay = settings.read().signupsPerDay;
  if (!perDay) return next();
  if (!dailySignups || dailySignups.perDay !== perDay) {
    dailySignups = Object.assign(rateLimit({
      perMinute: perDay / (24 * 60),
      burst: perDay,
      prefix: 48,
      counts: (res) => res.statusCode === 200,
      message: 'Too many accounts have been made from here today; please try again tomorrow'
    }), { perDay: perDay });
  }
  dailySignups(req, res, next);
}
authRouter.resetSignupsPerDay = () => {
  dailySignups = null;
};

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Emails are saved lowercase, but accounts made before that may not be (until
// scripts/migrate-emails.js has been run), so fall back to ignoring case.
function findByEmail(email) {
  return User.findOne({ email: email }).then((user) => user ||
    User.findOne({ email: new RegExp('^' + escapeRegExp(email) + '$', 'i') }));
}

authRouter.post('/signup', limiter, signupsPerDay, jsonParser, (req, res) => {
  const email = validate.normalizeEmail(req.body.email);
  const password = req.body.password;

  if (!email) {
    return res.status(400).json({ msg: validate.EMAIL_MESSAGE });
  }

  const problem = validate.passwordProblem(password);
  if (problem) {
    return res.status(400).json({ msg: problem });
  }

  var newUser = new User();
  newUser.email = email;
  newUser.hashPassword(password)
    .then(() => newUser.save())
    .then((data) => res.status(200).json({ token: data.generateToken(), email: newUser.email }))
    .catch((err) => {
      if (err.code === DUPLICATE_KEY) {
        return res.status(409).json({ msg: 'An account with that email already exists' });
      }
      handleDBError(err, res);
    });
});

authRouter.get('/signin', limiter, basicHTTP, (req, res) => {
  // The same answer, after the same amount of work, for an unknown email and a
  // wrong password, so the sign-in form can't be used to find out who has an
  // account.
  const failed = () => res.status(401).json({ msg: 'incorrect email or password' });
  const email = req.basicHTTP.email.trim().toLowerCase();
  const password = req.basicHTTP.password;

  findByEmail(email).then((user) => {
    if (!user) return User.dummyCompare(password).then(failed);
    return user.comparePassword(password).then((ok) => {
      if (!ok) return failed();
      res.json({ msg: 'Success in signin', token: user.generateToken(), email: user.email });
      upgradeAccount(user, password);
    });
  }).catch((err) => handleDBError(err, res));
});

// After a successful sign-in: bring an old, cheaper password hash up to the
// current cost, and lowercase a legacy mixed-case email. Neither is needed to
// sign in, so failures (e.g. a lowercase duplicate) are only logged.
function upgradeAccount(user, password) {
  const lower = user.email.toLowerCase();
  if (!user.needsRehash() && user.email === lower) return;
  user.email = lower;
  const rehash = user.needsRehash() ? user.hashPassword(password, { rehash: true }) : Promise.resolve();
  rehash.then(() => user.save())
    .catch((err) => console.log('Could not upgrade account ' + user._id + ': ' + err.message));
}
