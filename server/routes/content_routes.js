const express = require('express');
const jsonParser = require('body-parser').json({ limit: 10240000 });
const Content = require(__dirname + '/../models/content');
const handleDBError = require(__dirname + '/../lib/handle_db_error');
const jwtAuth = require(__dirname + '/../lib/jwt_auth');

var Readable = require('stream').Readable;
var Writable = require('stream').Writable;

var transformBlur = require('bindings')('matrix');

var PixelStream = require('pixel-stream');
var JPEGDecoder = require('jpg-stream/decoder');
var JPEGEncoder = require('jpg-stream/encoder');
var inherits = require('util').inherits;
var allPixels = [];

function MyPixelStream() {
  PixelStream.apply(this, arguments);
}

inherits(MyPixelStream, PixelStream);

MyPixelStream.prototype._writePixels = function(data, done) {
  for (var i = 0; i < data.length; i++) {
    allPixels.push(data[i]);
  }
  done();
};

MyPixelStream.prototype._end = function(done) {
  var translatedPixels = new Int32Array(allPixels);

  var newPix = transformBlur.blurry(translatedPixels, this.format.width, this.format.height);
  var bufTrans = new Buffer(newPix.length);
  for (var j = 0; j < translatedPixels.length; j++) {
    bufTrans[j] = newPix[j];
  }

  this.push(bufTrans);
  done();
};

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
  var newContent = new Content(req.body);
  newContent.user_id = req.user._id;
  newContent.tOption = req.body.tOption;
  newContent.content = req.body.content;
  const tempBuffer = new Buffer(req.body.content.slice(23), 'base64');
  var outArray = [];
  var myStream = Readable();
  var ws = Writable();
  ws._write = function(chunk, enc, next) {
    outArray.push(chunk);
    next();
  };
  ws.on('finish', function() {
    const transfer = new Buffer(req.body.content.length - 23);
    var i = 0;
    for (var k = 0; k < outArray.length; k++) {
      for (var l = 0; l < outArray[k].length; l++) {
        if (i < transfer.length) {
          transfer.writeUInt8(outArray[k][l], i++);
        }
      }
    }
    newContent.content = 'data:image/jpeg;base64,';
    newContent.content += transfer.toString('base64');

    newContent.save((err, data) => {

      if (err) return handleDBError(err, res);

      res.status(200).json(data);
    });
  });
  myStream.push(tempBuffer);
  myStream.push(null);
  myStream.pipe(new JPEGDecoder)
  .pipe(new MyPixelStream)
  .pipe(new JPEGEncoder)
  .pipe(ws);

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
