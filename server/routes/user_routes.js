const express = require('express');
const jsonParser = require('body-parser').json();
const mongoose = require('mongoose');

const basicHTTP = require(__dirname + '/../lib/basic_http');
const jwtAuth = require(__dirname + '/../lib/jwt_auth');

const User = require(__dirname + '/../models/user');

var userRouter = module.exports = exports = express.Router();

userRouter.get('/verify', jwtAuth, (req, res) => {

  User.find({
    user_id: req.user._id
    }, (err, data) => {
      if (err) {
        return res.status(500).json({
          msg: 'Error finding user'
        })
      }
      var content = {user : {
        _id : 1
      }};
      res.status(200).json({
        msg: 'User verified',
        content: content
      });
  });
});

userRouter.put('/usersettings/:id', jwtAuth, jsonParser, (req, res) => {
  var updateUser = req.body;
  delete updateUser._id;
  User.update({
    _id: req.params.id
  }, updateUser, (err) => {
    if (err) {
      return res.status(500).json({
        msg: 'Error updating user'
      })
    }
    res.status(200).json({
      msg: 'User updated'
    });
  });
});

userRouter.delete('/deleteuser/:id', jwtAuth, (req, res) => {
  User.remove({
    _id: req.params.id
  }, (err) => {
    if (err) {
      return res.status(500).json({
        msg: 'Error deleting user'
      })
    }
    res.status(200).json({
      msg: 'User deleted'
    });
  });
});
