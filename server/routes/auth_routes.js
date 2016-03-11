const express = require('express');
const User = require(__dirname + '/../models/user');
const jsonParser = require('body-parser').json();
const handleDBError = require(__dirname + '/../lib/handle_db_error');
const basicHTTP = require(__dirname + '/../lib/basic_http');
// const emailValidation = require(__dirname + '/../lib/email_validation.js');

function emailValidation(nnnotavar){
  if (nnnotavar) return true;
  return false;
}

const authRouter = express.Router();

authRouter.post('/signup', jsonParser, (req, res) => {
  // debugger;
  if (!(req.body.email || '').length && !emailValidation(req.body.email)) {
    return res.status(400).json({ msg: 'Please enter an email' });
  }

  if (!emailValidation(req.body.email)) {
    return res.status(400).json({ msg: 'Please enter a valid email' });
  }
  //
  // if (!(req.body.username || '').length) {
  //   return res.status(400).json({ msg: 'Please enter a user name' });
  // }

  if (!((req.body.password || '').length > 3)) {
    return res.status(400)
      .json({ msg: 'Please enter a password longer than 3 characters' });
  }

  var newUser = new User();
  newUser.email = req.body.email;
  // newUser.authentication.email = req.body.email;
  newUser.hashPassword(req.body.password);
  newUser.save((err, data) => {
    debugger;
    if (err) return handleDBError(err, res);
    res.status(200).json({token: data.generateToken(), email: newUser.email}); //to be replaced with an auth token
  });
  // temp for quickness

  // if (!(req.body.password === req.body.confirmpassword)) {
  //   return res.status(400).json({ msg: 'Passwords are not the same' });
  // }

  // User.find({
  //   $or: [{ 'username': req.body.username }, { 'email': req.body.email }]
  // }, (err, data) => {
  //   if (err) return handleDBError(err, res);
  //   if (data.length) {
  //     return res.status(400)
  //       .json({ msg: 'User already exists! Please use a different username' });
  //   }
  //   saveUserDB(req, res);
  // });
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

module.exports = exports = authRouter;
