'use strict';

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require(__dirname + '/../models/user');
const secret = require(__dirname + '/secret');

const unauthorized = (res) => res.status(401).json({ msg: 'could not authenticate user' });

module.exports = exports = (req, res, next) => {
  let decoded;
  try {
    decoded = jwt.verify(req.headers.token, secret, { algorithms: ['HS256'] });
  } catch (e) {
    return unauthorized(res);
  }

  // Only ever look up a plain id, never whatever object the token carries.
  if (!decoded || typeof decoded.id !== 'string' || !mongoose.isObjectIdOrHexString(decoded.id)) {
    return unauthorized(res);
  }

  User.findOne({ _id: decoded.id }).select('-password').then((user) => {
    if (!user) return unauthorized(res);
    // Tokens issued before the last password change no longer work.
    if (user.passwordChangedAt && decoded.iat < Math.floor(user.passwordChangedAt / 1000)) {
      return unauthorized(res);
    }
    req.user = user;
    next();
  }, (err) => {
    console.log('find error in jwt error' + err);
    return res.status(500).json({ msg: 'DB error' });
  });
};
