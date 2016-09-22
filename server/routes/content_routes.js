const express = require('express');
const jsonParser = require('body-parser').json({ limit: 10240000 });
const Content = require(__dirname + '/../models/content');
const handleDBError = require(__dirname + '/../lib/handle_db_error');
const jwtAuth = require(__dirname + '/../lib/jwt_auth');

var contentRouter = module.exports = exports = express.Router();

contentRouter.get('/getlatest', (req, res) => {
  Content.findOne({ contentId: req.user._id, $sortBy: 'createdOn' }, (err, data) => {
    if (err) return handleDBError(err, res);

    res.status(200).json(data);
  });
});

contentRouter.get('/getAll', jwtAuth, (req, res) => {
  Content.find({ user_id: req.user._id }, (err, data) => {
    if (err) return handleDBError(err, res);

    res.status(200).json(data);
  });
});

contentRouter.post('/newcontent', jwtAuth, jsonParser, (req, res) => {
  debugger;
  var newContent = new Content(req.body);
  newContent.user_id = req.user._id;
  newContent.content = req.body.content;
  newContent.tOption = req.body.tOption;
  newContent.save((err, data) => {

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
  // delete contentData.id;
  Content.update({ _id: req.params.id }, contentData, (err) => {
    if (err) return handleDBError(err, res);

    res.status(200).json({ msg: 'Successfully updated content' });
  });
});

contentRouter.delete('/delete/:id', jwtAuth, (req, res) => {
  Content.remove({ _id: req.params.id }, (err) => {
    if (err) return handleDBError(err, res);

    res.status(200).json({ msg: 'Successfully deleted content' });
  });
});
