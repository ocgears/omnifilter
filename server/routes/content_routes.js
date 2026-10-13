const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const Content = require(__dirname + '/../models/content');
const handleDBError = require(__dirname + '/../lib/handle_db_error');
const jwtAuth = require(__dirname + '/../lib/jwt_auth');
const gpuFilters = require(__dirname + '/../lib/gpu_filters');
const imageCodec = require(__dirname + '/../lib/image_codec');
const filterStack = require(__dirname + '/../lib/stack');
const transformQueue = require(__dirname + '/../lib/transform_queue');

// Photos arrive as data URLs, so /newcontent takes big bodies; everything
// else gets the small default.
const photoParser = bodyParser.json({ limit: 16000000 });
const smallParser = bodyParser.json({ limit: '100kb' });

var contentRouter = module.exports = exports = express.Router();

// Express 4 doesn't catch errors from async handlers, and an unhandled
// rejection stops Node, so pass them on to the error handler in server.js.
const asyncRoute = (handler) => (req, res, next) => handler(req, res, next).catch(next);

// A decoded photo takes width * height * 4 bytes (200 MB at the pixel limit)
// and the GPU runs one job at a time anyway, so only a couple of transforms
// run at once and a few more wait their turn; past that the server is busy.
// Each user gets one transform at a time. See lib/transform_queue.js.
const MAX_CONCURRENT_TRANSFORMS = 2;
const MAX_WAITING_TRANSFORMS = 8;
const transforms = contentRouter.transforms = transformQueue.create({
  maxRunning: MAX_CONCURRENT_TRANSFORMS,
  maxWaiting: MAX_WAITING_TRANSFORMS,
  maxPerKey: 1
});

function msSince(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

// The fields a user may change on a saved photo: their types and the longest
// value allowed (for tags, the most tags and the longest tag).
const EDITABLE = {
  title: { type: 'string', max: 200 },
  createdOn: { type: 'string', max: 100 },
  location: { type: 'string', max: 200 },
  tags: { type: 'string[]', max: 50, maxEach: 50 }
};

// Resolves the update to make, or { error } describing what's wrong.
function editableFields(body) {
  const update = {};
  for (const field of Object.keys(EDITABLE)) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    const rule = EDITABLE[field];
    const value = body[field];
    if (rule.type === 'string[]') {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
        return { error: field + ' must be a list of strings' };
      }
      if (value.length > rule.max || value.some((v) => v.length > rule.maxEach)) {
        return { error: 'At most ' + rule.max + ' ' + field + ' of up to ' + rule.maxEach + ' characters each' };
      }
    } else {
      if (typeof value !== 'string') return { error: field + ' must be a string' };
      if (value.length > rule.max) {
        return { error: field + ' can be at most ' + rule.max + ' characters' };
      }
    }
    update[field] = value;
  }
  return { update: update };
}

// The first filter in a stack that the device can't run, with why, or null.
// /filters marks these available: false.
function unavailableLayer(layers) {
  const names = new Set(layers.map((l) => l.tOption));
  const missing = gpuFilters.list().find((f) => names.has(f.name) && f.available === false);
  return missing ? missing.label + ' can\'t run on this server: ' + missing.unavailableReason : null;
}

const validId = (req, res, next) => {
  if (!mongoose.isObjectIdOrHexString(req.params.id)) {
    return res.status(404).json({ msg: 'No such content' });
  }
  next();
};

// The available filters and their parameters, for building the UI.
contentRouter.get('/filters', (req, res) => {
  res.status(200).json(gpuFilters.list());
});

// The OpenCL device the filters run on, for the page to show.
contentRouter.get('/device', (req, res) => {
  try {
    const device = gpuFilters.deviceInfo();
    res.status(200).json({
      name: device.name,
      type: device.type,
      platform: device.platform,
      version: device.version.trim()
    });
  } catch (e) {
    console.log('No OpenCL device: ' + e.message);
    res.status(503).json({ msg: 'No OpenCL device is available' });
  }
});

// Ready-made filter stacks, and the controls every layer of a stack has.
contentRouter.get('/presets', (req, res) => {
  res.status(200).json({
    maxLayers: filterStack.MAX_LAYERS,
    layerParams: filterStack.LAYER_PARAMS,
    presets: filterStack.presets()
  });
});

contentRouter.get('/getlatest', jwtAuth, (req, res) => {
  Content.findOne({ user_id: req.user._id }).sort({ createdAt: -1 })
    .then((data) => res.status(200).json(data))
    .catch((err) => handleDBError(err, res));
});

contentRouter.get('/getAll', jwtAuth, (req, res) => {
  Content.find({ user_id: req.user._id }).sort({ createdAt: -1 })
    .then((data) => res.status(200).json(data))
    .catch((err) => handleDBError(err, res));
});

// Saves a photo, after applying either one filter ({ tOption, params }) or a
// stack of them ({ stack: [{ tOption, params, amount, blend }, ...] }). With
// neither, the photo is saved as it is.
contentRouter.post('/newcontent', jwtAuth, photoParser, asyncRoute(async (req, res) => {
  const tOption = req.body.tOption || '';
  var content = req.body.content;

  if (typeof content !== 'string' || !content.length) {
    return res.status(400).json({ msg: 'No image content was sent' });
  }
  if (typeof tOption !== 'string') {
    return res.status(400).json({ msg: 'tOption must be the name of a filter' });
  }

  const isStack = req.body.stack !== undefined;
  var tParams;
  var layers = null;
  if (isStack) {
    try {
      layers = filterStack.normalizeStack(req.body.stack);
    } catch (e) {
      return res.status(400).json({ msg: e.message });
    }
  } else if (tOption) {
    if (!gpuFilters.has(tOption)) {
      return res.status(400).json({ msg: 'Unknown transformation: ' + tOption });
    }
    tParams = gpuFilters.normalizeParams(tOption, req.body.params);
    layers = [{ tOption: tOption, tParams: tParams, amount: 100, blend: 'normal' }];
  }

  if (!layers) {
    // Saved as is, so check it the same way as a photo to transform.
    try {
      content = await imageCodec.validateDataUrl(content);
    } catch (e) {
      if (!e.status) throw e;
      return res.status(e.status).json({ msg: e.message });
    }
  } else {
    const unavailable = unavailableLayer(layers);
    if (unavailable) return res.status(400).json({ msg: unavailable });

    // If the client goes away while the transform is waiting, drop it.
    const cancel = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) cancel.abort();
    });

    var failure;
    try {
      failure = await transforms.run(String(req.user._id), async () => {
        var image;
        try {
          image = await imageCodec.decodeDataUrl(content);
        } catch (e) {
          if (!e.status) console.log('Error in decoding the image: ', e);
          return { status: 400, msg: 'Could not read the image' + (e.status ? ': ' + e.message : '') };
        }

        try {
          const start = process.hrtime.bigint();
          image.data = await filterStack.applyStack(layers, image.data, image.width, image.height);
          console.log('Applied ' + layers.map((l) => l.tOption).join(' + ') + ' to ' +
            image.width + 'x' + image.height + ' image in ' + msSince(start).toFixed(1) + 'ms');
        } catch (e) {
          // The device can't run this filter, at all or at this size.
          if (e.code === 'UNSUPPORTED') return { status: e.status || 400, msg: e.message };
          if (e.code === 'NO_DEVICE') {
            console.log('No OpenCL device for a transform: ' + e.message);
            return { status: 503, msg: 'No OpenCL device is available to run filters' };
          }
          console.log('Error in transforming the image: ', e);
          return { status: 500, msg: 'transform failure' };
        }

        try {
          content = await imageCodec.encodeDataUrl(image);
        } catch (e) {
          if (e.status) return { status: e.status, msg: e.message };
          console.log('Error in encoding the image: ', e);
          return { status: 500, msg: 'Could not encode the transformed image' };
        }
      }, cancel.signal);
    } catch (e) {
      if (e.aborted) return; // nobody is listening
      if (!e.status) throw e;
      if (e.retryAfter) res.set('Retry-After', String(e.retryAfter));
      return res.status(e.status).json({ msg: e.message });
    }
    if (failure) return res.status(failure.status).json({ msg: failure.msg });
  }

  const data = await Content.create({
    user_id: req.user._id,
    tOption: isStack ? '' : tOption,
    tParams: tParams,
    tStack: isStack ? layers : [],
    content: content
  });
  res.status(200).json(data);
}));

contentRouter.put('/preview/:id', jwtAuth, validId, smallParser, (req, res) => {
  const fields = editableFields(req.body);
  if (fields.error) return res.status(400).json({ msg: fields.error });
  if (!Object.keys(fields.update).length) return res.status(400).json({ msg: 'Nothing to update' });
  Content.updateOne({ _id: req.params.id, user_id: req.user._id }, { $set: fields.update })
    .then((result) => {
      if (!result.matchedCount) return res.status(404).json({ msg: 'No such content' });
      res.status(200).json({ msg: 'Successfully updated content' });
    })
    .catch((err) => handleDBError(err, res));
});

contentRouter.delete('/delete/:id', jwtAuth, validId, (req, res) => {
  Content.deleteOne({ _id: req.params.id, user_id: req.user._id })
    .then((result) => {
      if (!result.deletedCount) return res.status(404).json({ msg: 'No such content' });
      res.status(200).json({ msg: 'Successfully deleted content' });
    })
    .catch((err) => handleDBError(err, res));
});
