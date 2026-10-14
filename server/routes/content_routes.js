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
const rateLimit = require(__dirname + '/../lib/rate_limit');

// Photos arrive as data URLs, so /newcontent takes big bodies.
const photoParser = bodyParser.json({ limit: 16000000 });

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

// The device the filters run on, for the page to show.
contentRouter.get('/device', asyncRoute(async (req, res) => {
  try {
    await gpuFilters.ready();
    const device = gpuFilters.deviceInfo();
    res.status(200).json({
      name: device.name,
      type: device.type,
      platform: device.platform,
      version: device.version.trim()
    });
  } catch (e) {
    console.log('No ' + gpuFilters.backendLabel + ' device: ' + e.message);
    res.status(503).json({ msg: 'No ' + gpuFilters.backendLabel + ' device is available' });
  }
}));

// Ready-made filter stacks, and the controls every layer of a stack has.
contentRouter.get('/presets', (req, res) => {
  res.status(200).json({
    maxLayers: filterStack.MAX_LAYERS,
    layerParams: filterStack.LAYER_PARAMS,
    presets: filterStack.presets()
  });
});

contentRouter.get('/getAll', jwtAuth, (req, res) => {
  Content.find({ user_id: req.user._id }).sort({ createdAt: -1 })
    .then((data) => res.status(200).json(data))
    .catch((err) => handleDBError(err, res));
});

// What a request asks to be applied: either one filter ({ tOption, params })
// or a stack of them ({ stack: [{ tOption, params, amount, blend }, ...] }).
// Resolves with { tOption, tParams, tStack, layers } (layers null for none),
// or an Error with a status and a message for the client.
function readRecipe(body) {
  const tOption = body.tOption || '';
  if (typeof tOption !== 'string') {
    return { error: 'tOption must be the name of a filter' };
  }
  if (body.stack !== undefined) {
    try {
      const layers = filterStack.normalizeStack(body.stack);
      return { tOption: '', tParams: undefined, tStack: layers, layers: layers };
    } catch (e) {
      return { error: e.message };
    }
  }
  if (!tOption) return { tOption: '', tParams: undefined, tStack: [], layers: null };
  if (!gpuFilters.has(tOption)) return { error: 'Unknown transformation: ' + tOption };
  const tParams = gpuFilters.normalizeParams(tOption, body.params);
  return {
    tOption: tOption,
    tParams: tParams,
    tStack: [],
    layers: [{ tOption: tOption, tParams: tParams, amount: 100, blend: 'normal' }]
  };
}

// Applies the recipe's filters to the photo in req.body.content, waiting its
// turn in `queue` under `key`. Resolves with the new data URL, or with
// undefined once it has sent an error reply (or the client has gone).
// A recipe with no filters checks the photo and returns it as it is.
async function transformPhoto(req, res, recipe, options) {
  const content = req.body.content;
  if (!recipe.layers) {
    // Saved as is, so check it the same way as a photo to transform.
    try {
      return await imageCodec.validateDataUrl(content);
    } catch (e) {
      if (!e.status) throw e;
      res.status(e.status).json({ msg: e.message });
      return undefined;
    }
  }

  const layers = recipe.layers;
  const unavailable = unavailableLayer(layers);
  if (unavailable) {
    res.status(400).json({ msg: unavailable });
    return undefined;
  }

  // If the client goes away while the transform is waiting, drop it.
  const cancel = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) cancel.abort();
  });

  var result;
  try {
    result = await options.queue.run(options.key, async () => {
      var image;
      try {
        image = await imageCodec.decodeDataUrl(content, { maxPixels: options.maxPixels });
      } catch (e) {
        if (!e.status) console.log('Error in decoding the image: ', e);
        return { status: 400, msg: 'Could not read the image' + (e.status ? ': ' + e.message : '') };
      }

      try {
        const start = process.hrtime.bigint();
        image.data = await filterStack.applyStack(layers, image.data, image.width, image.height);
        console.log('Applied ' + layers.map((l) => l.tOption).join(' + ') + ' to ' +
          image.width + 'x' + image.height + ' image in ' + msSince(start).toFixed(1) + 'ms' +
          (options.guest ? ' for a guest' : ''));
      } catch (e) {
        // The device can't run this filter, at all or at this size.
        if (e.code === 'UNSUPPORTED') return { status: e.status || 400, msg: e.message };
        if (e.code === 'NO_DEVICE') {
          console.log('No ' + gpuFilters.backendLabel + ' device for a transform: ' + e.message);
          return { status: 503, msg: 'No ' + gpuFilters.backendLabel + ' device is available to run filters' };
        }
        console.log('Error in transforming the image: ', e);
        return { status: 500, msg: 'transform failure' };
      }

      try {
        return { content: await imageCodec.encodeDataUrl(image) };
      } catch (e) {
        if (e.status) return { status: e.status, msg: e.message };
        console.log('Error in encoding the image: ', e);
        return { status: 500, msg: 'Could not encode the transformed image' };
      }
    }, cancel.signal);
  } catch (e) {
    if (e.aborted) return undefined; // nobody is listening
    if (!e.status) throw e;
    if (e.retryAfter) res.set('Retry-After', String(e.retryAfter));
    res.status(e.status).json({ msg: e.message });
    return undefined;
  }
  if (result.status) {
    res.status(result.status).json({ msg: result.msg });
    return undefined;
  }
  return result.content;
}

function checkContent(req, res) {
  const content = req.body.content;
  if (typeof content !== 'string' || !content.length) {
    res.status(400).json({ msg: 'No image content was sent' });
    return false;
  }
  return true;
}

// Saves a photo, after applying either one filter ({ tOption, params }) or a
// stack of them ({ stack: [{ tOption, params, amount, blend }, ...] }). With
// neither, the photo is saved as it is.
contentRouter.post('/newcontent', jwtAuth, photoParser, asyncRoute(async (req, res) => {
  if (!checkContent(req, res)) return;
  const recipe = readRecipe(req.body);
  if (recipe.error) return res.status(400).json({ msg: recipe.error });

  const content = await transformPhoto(req, res, recipe, {
    queue: transforms,
    key: String(req.user._id)
  });
  if (content === undefined) return;

  const data = await Content.create({
    user_id: req.user._id,
    tOption: recipe.tOption,
    tParams: recipe.tParams,
    tStack: recipe.tStack,
    content: content
  });
  res.status(200).json(data);
}));

// Guest mode: anyone can try the filters without an account. Their photos
// aren't saved here (the page keeps them in the browser), and since anyone
// can call this, guests get a smaller share of the server: one transform at
// a time each and one for all guests together, a few a minute per IP address
// (set TRUST_PROXY behind a proxy, so that's the visitor's address), and a
// smaller photo size (16 megapixels takes a 12-megapixel phone photo; the page
// scales down bigger ones first). OMNIFILTER_GUESTS=off turns it off.
const GUESTS_ON = !/^(off|false|0|no)$/i.test(process.env.OMNIFILTER_GUESTS || '');
const GUEST_MAX_PIXELS = Number(process.env.OMNIFILTER_GUEST_MAX_PIXELS) || 16e6;
const guestTransforms = contentRouter.guestTransforms = transformQueue.create({
  maxRunning: 1,
  maxWaiting: 4,
  maxPerKey: 1
});
const guestLimiter = contentRouter.guestLimiter = rateLimit({
  perMinute: Number(process.env.GUEST_RATE_PER_MINUTE) || 6,
  burst: Number(process.env.GUEST_RATE_BURST) || 3,
  message: 'You have made a lot of photos; wait a minute, or create an account to carry on'
});

// The settings for guest mode, for the page.
contentRouter.get('/guest', (req, res) => {
  res.status(200).json({
    enabled: GUESTS_ON,
    maxPixels: Math.min(GUEST_MAX_PIXELS, imageCodec.MAX_PIXELS)
  });
});

// Applies filters as /newcontent does, but saves nothing: replies with the
// photo and what was applied, in the shape of a saved photo without an _id.
contentRouter.post('/transform', (req, res, next) => {
  if (!GUESTS_ON) return res.status(403).json({ msg: 'Sign in to use the filters on this server' });
  next();
}, guestLimiter, photoParser, asyncRoute(async (req, res) => {
  if (!checkContent(req, res)) return;
  const recipe = readRecipe(req.body);
  if (recipe.error) return res.status(400).json({ msg: recipe.error });
  if (!recipe.layers) return res.status(400).json({ msg: 'Choose a filter to apply' });

  const content = await transformPhoto(req, res, recipe, {
    queue: guestTransforms,
    key: 'guest:' + req.ip,
    maxPixels: GUEST_MAX_PIXELS,
    guest: true
  });
  if (content === undefined) return;
  res.status(200).json({
    tOption: recipe.tOption,
    tParams: recipe.tParams,
    tStack: recipe.tStack,
    content: content,
    createdAt: new Date()
  });
}));

// Saves a photo that was made before signing in (by /transform, kept in the
// browser), with the filters it says it was made with. The photo is checked
// as one saved without a filter is; the filters are only a description, so
// they're checked to be real but not applied.
contentRouter.post('/import', jwtAuth, photoParser, asyncRoute(async (req, res) => {
  if (!checkContent(req, res)) return;
  const recipe = readRecipe(req.body);
  if (recipe.error) return res.status(400).json({ msg: recipe.error });

  var content;
  try {
    content = await imageCodec.validateDataUrl(req.body.content);
  } catch (e) {
    if (!e.status) throw e;
    return res.status(e.status).json({ msg: e.message });
  }
  const made = new Date(req.body.createdAt);
  const data = await Content.create({
    user_id: req.user._id,
    tOption: recipe.tOption,
    tParams: recipe.tParams,
    tStack: recipe.tStack,
    content: content,
    // When it was made, if that's believable.
    createdAt: made.getTime() > 0 && made <= new Date() ? made : new Date()
  });
  res.status(200).json(data);
}));

contentRouter.delete('/delete/:id', jwtAuth, validId, (req, res) => {
  Content.deleteOne({ _id: req.params.id, user_id: req.user._id })
    .then((result) => {
      if (!result.deletedCount) return res.status(404).json({ msg: 'No such content' });
      res.status(200).json({ msg: 'Successfully deleted content' });
    })
    .catch((err) => handleDBError(err, res));
});
