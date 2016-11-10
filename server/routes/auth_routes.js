const express = require('express');
const User = require(__dirname + '/../models/user');
const jsonParser = require('body-parser').json();
const handleDBError = require(__dirname + '/../lib/handle_db_error');
const basicHTTP = require(__dirname + '/../lib/basic_http');

const authRouter = module.exports = exports = express.Router();

authRouter.post('/signup', jsonParser, (req, res) => {

  if ((req.body.email || '').length < 5) {
    return res.status(400).json({ msg: 'Please enter an email' });
  }

  if (!((req.body.password || '').length > 7)) {
    return res.status(400)
      .json({ msg: 'Please enter a password longer than 7 characters' });
  }

  var newUser = new User();
  newUser.email = req.body.email;
  newUser.hashPassword(req.body.password);
  newUser.save((err, data) => {
    if (err) return handleDBError(err, res);
    res.status(200).json({ token: data.generateToken(), email: newUser.email });
  });
});

authRouter.get('/signin', basicHTTP, (req, res) => {

  User.findOne({ 'email': req.basicHTTP.email }, (err, user) => {

    if (err) return handleDBError(err, res);

    if (!user) return res.status(401).json({ msg: 'no user exists' });

    if (!user.comparePassword(req.basicHTTP.password)) {
      return res.status(401).json({ msg: 'incorrect password' });
    }

    res.json({ msg: 'Success in signin', token: user.generateToken(), email: user.email });
  });
});
