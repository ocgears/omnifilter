'use strict';

const User = require(__dirname + '/../models/user');
const jwt = require('jsonwebtoken');

module.exports = exports = (req, res, next) => {
  let decoded;
  try {
    decoded =
      jwt.verify(req.headers.token, process.env.APP_SECRET || 'changethis');
  } catch (e) {
    return res.status(401).json({ msg: 'could not authenticate user' });
  }

  if (!decoded) return res.status(401).json({ msg: 'could not authenticate user' });

  User.findOne({ _id: decoded.id }, (err, user) => {
    // console.log('got a new user info from db : ' + user); // uses _id
    if (err) {
      console.log('find error in jwt error' + err);
      return res.status(500).json({ msg: 'DB error' });
    }
    if (!user) return res.status(401).json({ msg: 'Error finding user' });
    delete user.password;
    req.user = user;
    next();
  });
};
