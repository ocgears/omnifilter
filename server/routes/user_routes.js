const express = require('express');
const jsonParser = require('body-parser').json({ limit: '10kb' });
const jwtAuth = require(__dirname + '/../lib/jwt_auth');
const handleDBError = require(__dirname + '/../lib/handle_db_error');
const validate = require(__dirname + '/../lib/validate');

const User = require(__dirname + '/../models/user');
const Content = require(__dirname + '/../models/content');

const DUPLICATE_KEY = 11000;

const tokenFilter = (req, res, next) => {
  if (!req.headers.token || req.headers.token === 'null') {
    return res.status(200).json({ msg: 'No token yet, so there is no email to find. Goodbye.' });
  }
  next();
};

var userRouter = module.exports = exports = express.Router();

const ownAccountOnly = (req, res, next) => {
  if (String(req.user._id) !== req.params.id) {
    return res.status(403).json({ msg: 'You can only change your own account' });
  }
  next();
};

// Loads the account with its password hash and checks req.body.currentPassword
// against it, so a stolen token alone can't change or delete the account.
// Leaves the user in req.account.
const currentPasswordRequired = (req, res, next) => {
  User.findOne({ _id: req.user._id }).then((user) => {
    // Deleted since jwtAuth looked it up.
    if (!user) return res.status(401).json({ msg: 'could not authenticate user' });
    return user.comparePassword(req.body.currentPassword).then((ok) => {
      if (!ok) return res.status(403).json({ msg: 'Your current password is incorrect' });
      req.account = user;
      next();
    });
  }).catch((err) => handleDBError(err, res));
};

userRouter.get('/verify', tokenFilter, jwtAuth, (req, res) => {
  res.status(200).json({
    msg: 'User verified',
    email: req.user.email,
    id: req.user.id
  });
});

const checkSettings = (req, res, next) => {
  const email = req.body.email;
  const password = req.body.password;
  if (email !== undefined && !validate.normalizeEmail(email)) {
    return res.status(400).json({ msg: validate.EMAIL_MESSAGE });
  }
  const problem = password !== undefined && validate.passwordProblem(password);
  if (problem) {
    return res.status(400).json({ msg: problem });
  }
  if (email === undefined && password === undefined) {
    return res.status(400).json({ msg: 'Nothing to update' });
  }
  next();
};

// Changes the email and/or password. Both need the current password.
userRouter.put('/usersettings/:id', jwtAuth, ownAccountOnly, jsonParser, checkSettings,
  currentPasswordRequired, (req, res) => {
    const user = req.account;
    if (req.body.email !== undefined) user.email = validate.normalizeEmail(req.body.email);
    const hashed = req.body.password !== undefined ? user.hashPassword(req.body.password) : Promise.resolve();
    hashed.then(() => user.save()).then((saved) => {
      // Changing the password signs out other sessions, so hand back a new token.
      res.status(200).json({ msg: 'User updated', email: saved.email, token: saved.generateToken() });
    }).catch((err) => {
      if (err.code === DUPLICATE_KEY) {
        return res.status(409).json({ msg: 'An account with that email already exists' });
      }
      handleDBError(err, res);
    });
  });

// Deletes the account and its photos. Needs { currentPassword } in the body.
userRouter.delete('/deleteuser/:id', jwtAuth, ownAccountOnly, jsonParser, currentPasswordRequired, (req, res) => {
  Content.deleteMany({ user_id: req.params.id })
    .then(() => User.deleteOne({ _id: req.params.id }))
    .then(() => {
      res.status(200).json({
        msg: 'User deleted'
      });
    }, (err) => {
      console.log('Error deleting user: ' + err);
      res.status(500).json({
        msg: 'Error deleting user'
      });
    });
});
