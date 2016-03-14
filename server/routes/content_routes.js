
const express = require('express');
const jsonParser = require('body-parser').json();
const Content = require(__dirname + '/../models/content');
const handleDBError = require(__dirname + '/../lib/handle_db_error');
const jwtAuth = require(__dirname + '/../lib/jwt_auth');

var contentRouter = module.exports = exports = express.Router();

contentRouter.get('/getlatest', (req, res) => {
  Content.find({}, (err, data) => {
    if (err) return handleDBError(err, res);

    res.status(200).json(data);
  });
});

contentRouter.get('/getall', jwtAuth, (req, res) => {
  Content.find({contentId: req.user._id}, (err, data) => {
    if (err) return handleDBError(err, res);

    res.status(200).json(data);
  });

});

contentRouter.post('/newcontent', jwtAuth, jsonParser, (req, res) => {
  debugger;
  var newContent = new Content(req.body);
  newContent.user_id = req.user._id;
  newContent.content = req.body.content;
  newContent.save((err, data) => {
    debugger;
    if (err) return handleDBError(err, res);

    res.status(200).json(data);
  });
});

contentRouter.post('/save', jwtAuth, jsonParser, (req, res) => {
  var newContent = new Content(req.body);
  newContent.user_id = req.user._id;
  newContent.save((err, data) => {
    if (err) return handleDBError(err, res);

    res.status(200).json(data);
  });
});

contentRouter.put('/preview/:id', jwtAuth, jsonParser, (req, res) => {
  var contentData = req.body;
  delete contentData._id;
  Content.update({_id: req.params.id}, contentData, (err) => {
    if (err) return handleDBError(err, res);

    res.status(200).json({msg: 'Successfully updated content'});
  });
});

contentRouter.delete('/delete/:id', jwtAuth, (req, res) => {
  Content.remove({_id: req.params.id}, (err) => {
    if (err) return handleDBError(err, res);

    res.status(200).json({msg: 'Successfully deleted content'});
  });
});
