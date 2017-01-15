const express = require('express');
const jsonParser = require('body-parser').json({ limit: 16000000 });
const Content = require(__dirname + '/../models/content');
const handleDBError = require(__dirname + '/../lib/handle_db_error');
const jwtAuth = require(__dirname + '/../lib/jwt_auth');

var Readable = require('stream').Readable;
var Writable = require('stream').Writable;

var transformBlur = require('bindings')('matrix');

var PixelStream = require('pixel-stream');
var inherits = require('util').inherits;

var contentRouter = module.exports = exports = express.Router();

contentRouter.get('/getlatest', jwtAuth, (req, res) => {
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
  function MyPixelStream() {
    PixelStream.apply(this, arguments);
  }

  inherits(MyPixelStream, PixelStream);

  MyPixelStream.prototype._writePixels = function(data, done) {
    for (var i = 0; i < data.length; i++) {
      allPixels.push(data[i]);
    }
    data = null;
    done();
  };

  MyPixelStream.prototype._end = function(done) {
    var translatedPixels = new Uint8Array(allPixels);
    allPixels = null;
    allPixels = [];
    try {
      var newPix = new Int16Array(transformBlur.blurry(translatedPixels,
        this.format.width, this.format.height));
      translatedPixels = null;
    } catch (e) {
      console.log('Error in transforming the image: ', e);
      return res.status(500).json( { msg: 'transform failure' } );
    }

    var bufTrans = new Buffer(newPix);
    newPix = null;
    this.push(bufTrans);
    bufTrans = null;
    done();
  };

  try {
    const JPEGDecoder = require('jpg-stream/decoder');
    const JPEGEncoder = require('jpg-stream/encoder');

    if (req.body.content.length > 16000000) {
      return res.status(500).json( { 'msg': 'Error: image too large' } );
    }
    var allPixels = [];

    var newContent = new Content();
    newContent.user_id = req.user._id;
    newContent.tOption = req.body.tOption;

    if ( newContent.tOption === 'blur') {
      var tempBuffer = new Buffer(req.body.content.slice(23), 'base64');
      var lenOfBodyContent = req.body.content.length;
      req.body.content = null;
      var outArray = [];
      var myStream = Readable();
      var ws = Writable();

      ws._write = function(chunk, enc, next) {
        outArray.push(chunk);
        next();
      };

      ws.on('finish', function() {
        var transfer = new Buffer(lenOfBodyContent - 23);
        var i = 0;
        for (var k = 0; k < outArray.length; k++) {
          for (var l = 0; l < outArray[k].length; l++) {
            if (i < transfer.length) {
              transfer.writeUInt8(outArray[k][l], i++);
            }
          }
        }
        outArray = null;

        newContent.content = 'data:image/jpeg;base64,';
        newContent.content += transfer.toString('base64');
        transfer = null;
        newContent.save((err, data) => {

          if (err) return handleDBError(err, res);

          res.status(200).json(data);
        });
        newContent = null;
      });

      try {
        myStream.push(tempBuffer);
        myStream.push(null);
        tempBuffer = null;
        myStream.pipe(new JPEGDecoder())
        .pipe(new MyPixelStream())
        .pipe(new JPEGEncoder())
        .pipe(ws);
        myStream = null;
      } catch (e) {
        console.log('Error in processing image: ', e);
      }

    } else {
      newContent.content = req.body.content;
      newContent.save((err, data) => {

        if (err) return handleDBError(err, res);

        res.status(200).json(data);
      });
      newContent = null;
    }
  } catch (bigError) {
    console.log('Big error in content route: ', bigError);
  }

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
