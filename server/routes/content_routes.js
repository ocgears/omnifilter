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
const settings = require(__dirname + '/../lib/settings');

// Photos arrive as data URLs, so /newcontent takes big bodies.
const photoParser = bodyParser.json({ limit: 16000000 });

var contentRouter = module.exports = exports = express.Router();

// Reading, checking and saving a 16 MB photo holds several copies of it at
// once (about 80 MB all told), so only a couple of photos are taken in at a
// time and a few more wait, unread, for their turn; past that the server is
// busy. Each account sends one at a time, which also stops saves made at the
// same moment from all slipping under the photo limit.
const uploads = contentRouter.uploads = transformQueue.create({
  maxRunning: 2,
  maxWaiting: 6,
  maxPerKey: 1,
  perKeyMessage: 'You are already saving a photo; wait for it to finish'
});

// Middleware: the rest of the request runs in one of the upload slots, which
// is given back once the reply has gone (or the client has).
function oneUploadAtATime(req, res, next) {
  const cancel = new AbortController();
  const done = new Promise((resolve) => res.once('close', resolve));
  res.once('close', () => cancel.abort());
  uploads.run(String(req.user._id), () => {
    next();
    return done;
  }, cancel.signal).catch((e) => {
    if (e.aborted || res.headersSent) return;
    if (e.retryAfter) res.set('Retry-After', String(e.retryAfter));
    res.status(e.status || 500).json({ msg: e.message });
  });
}


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

// The device the filters run on, for the page to show; null when this server
// doesn't filter (cloud mode), so it has no device to set up or report.
contentRouter.get('/device', async (req, res) => {
  if (!settings.serverDevice(settings.read())) return res.status(200).json(null);
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
});

// Ready-made filter stacks, and the controls every layer of a stack has.
contentRouter.get('/presets', (req, res) => {
  res.status(200).json({
    maxLayers: filterStack.MAX_LAYERS,
    layerParams: filterStack.LAYER_PARAMS,
    presets: filterStack.presets()
  });
});

// The user's photos, newest first: what each was made with, its size and
// type, and its thumbnail; not the photos themselves (GET /content/:id).
// ?limit=n gives at most n (up to 100), and ?before=<id> the ones after that
// photo, for paging through a big gallery; without them, every photo. The
// Omnifilter-Total header says how many there are in all.
contentRouter.get('/getAll', jwtAuth, async (req, res) => {
  await upgradeOldPhotos(req.user._id);
  const filter = { user_id: req.user._id };
  if (req.query.before !== undefined) {
    const before = mongoose.isObjectIdOrHexString(req.query.before) &&
      await Content.findOne({ _id: req.query.before, user_id: req.user._id }).select('createdAt');
    if (!before) return res.status(400).json({ msg: 'before must be the id of one of your photos' });
    // Older, or as old with a smaller id: the order below, carried on.
    // (Marked trusted: sanitizeFilter would otherwise turn $lt into a value.)
    filter.$or = [
      { createdAt: mongoose.trusted({ $lt: before.createdAt }) },
      { createdAt: before.createdAt, _id: mongoose.trusted({ $lt: before._id }) }
    ];
  }
  const limit = parseInt(req.query.limit, 10);
  var query = Content.find(filter).select('-image -content').sort({ createdAt: -1, _id: -1 });
  if (limit > 0) query = query.limit(Math.min(limit, 100));
  const [data, total] = await Promise.all([query, Content.countDocuments({ user_id: req.user._id })]);
  res.set('Omnifilter-Total', String(total));
  res.status(200).json(data);
});

// Photos kept before there were thumbnails hold the photo as a data URL;
// this moves them to the binary photo and a thumbnail, once, one at a time.
// One that can't be read stays as it was (its thumbnail is missing).
async function upgradeOldPhotos(userId) {
  const old = await Content.find({ user_id: userId, image: mongoose.trusted({ $exists: false }) })
    .select('_id');
  for (const { _id } of old) {
    const photo = await Content.findById(_id);
    if (!photo || photo.image || typeof photo.content !== 'string') continue;
    try {
      const stored = await imageCodec.toStored(photo.content);
      photo.set(stored);
      photo.content = undefined;
      await photo.save();
    } catch (e) {
      console.log('Could not upgrade the kept photo ' + _id + ': ' + e.message);
    }
  }
}

// A kept photo itself, as its own type of file (?download for a file to
// save, named like the page names it, or ?download=name). Not cached: the
// address is the same for anyone who signs in on this browser.
contentRouter.get('/content/:id', jwtAuth, validId, async (req, res) => {
  const photo = await Content.findOne({ _id: req.params.id, user_id: req.user._id });
  if (!photo) return res.status(404).json({ msg: 'No such content' });
  var bytes = photo.image;
  var mime = photo.mime;
  if (!bytes) {
    const legacy = typeof photo.content === 'string' && /^data:(image\/[\w.+-]+);base64,/.exec(photo.content);
    if (!legacy) return res.status(404).json({ msg: 'No such content' });
    mime = legacy[1];
    bytes = Buffer.from(photo.content.slice(legacy[0].length), 'base64');
  }
  res.set('Cache-Control', 'private, no-store');
  if (req.query.download !== undefined) {
    const asked = typeof req.query.download === 'string' ? req.query.download : '';
    const name = /^[\w.-]{1,100}$/.test(asked) ? asked : 'omnifilter-' + String(photo._id).slice(-6) + '.' +
      (EXTENSIONS[mime] || 'img');
    res.set('Content-Disposition', 'attachment; filename="' + name + '"');
  }
  res.type(mime).send(bytes);
});

const EXTENSIONS = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif'
};

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

// Applies the recipe's filters to the photo in req.photo (see readUpload),
// waiting its turn in `queue` under `key`. Resolves with the new photo, as
// { bytes, mime }, or with undefined once it has sent an error reply (or the
// client has gone). A recipe with no filters checks the photo and returns
// it as it is.
async function transformPhoto(req, res, recipe, options) {
  const photo = req.photo;
  if (!recipe.layers) {
    // Saved as is, so check it the same way as a photo to transform.
    try {
      return await imageCodec.validatePhoto(photo);
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
        image = await imageCodec.decode(photo, { maxPixels: options.maxPixels });
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
        return { photo: await imageCodec.encode(image) };
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
  return result.photo;
}

// Replies 403 and returns false when this server doesn't run filters for
// the caller (OMNIFILTER_PROCESSING or OMNIFILTER_GUESTS is device, or
// guests are off): their browser filters on their own GPU instead.
function serverMayFilter(res, guest) {
  const s = settings.read();
  if (guest ? settings.guestServerFilters(s) : settings.serverFilters(s)) return true;
  res.status(403).json({
    msg: guest && s.guests === 'off' ? 'Sign in to use the filters on this server' :
      'On this server, filters run on your own device'
  });
  return false;
}

// Middleware: replies 409 when the user already keeps as many photos as this
// server allows (OMNIFILTER_MAX_STORED_PHOTOS), before the photo is read.
// After oneUploadAtATime, so no other save of theirs is under way.
const roomForAnother = async (req, res, next) => {
  const limit = settings.read().maxStoredPhotos;
  if (!limit) return next();
  const kept = await Content.countDocuments({ user_id: req.user._id });
  if (kept < limit) return next();
  res.status(409).json({
    msg: 'You already keep ' + kept + ' photos, as many as this server allows; delete one to keep this',
    limit: limit
  });
};

// A photo comes either as the image file itself (Content-Type image/...,
// which the page sends), with what it was made with as JSON in an
// Omnifilter-Recipe header ({ tOption, params } or { stack }, and for
// /import createdAt), or as JSON with the photo as a data URL in `content`
// and the rest alongside. The file takes a quarter less to send, and the
// server holds one copy of it rather than three.
const photoFile = express.raw({ type: 'image/*', limit: 16000000 });
const RECIPE_HEADER = 'Omnifilter-Recipe';

// Middleware, after the body parsers: the photo's bytes go in req.photo,
// and req.body is the recipe.
function readUpload(req, res, next) {
  if (Buffer.isBuffer(req.body)) {
    var recipe = {};
    const header = req.get(RECIPE_HEADER);
    if (header) {
      try {
        recipe = header.length <= 8192 ? JSON.parse(header) : null;
      } catch (e) {
        recipe = null;
      }
      if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) {
        return res.status(400).json({ msg: RECIPE_HEADER + ' must be a JSON object of at most 8 kB' });
      }
    }
    req.photo = req.body;
    req.body = recipe;
  } else {
    const content = req.body.content;
    if (typeof content !== 'string' || !content.length) {
      return res.status(400).json({ msg: 'No image content was sent' });
    }
    try {
      req.photo = imageCodec.bytesOf(content);
    } catch (e) {
      return res.status(e.status || 400).json({ msg: e.message });
    }
    // The long string can go now.
    req.body.content = undefined;
  }
  if (!req.photo.length) return res.status(400).json({ msg: 'No image content was sent' });
  next();
}

// What comes before a photo to keep is used: who it's for, its turn, room,
// and the photo itself.
const keepingPhoto = [jwtAuth, oneUploadAtATime, roomForAnother, photoParser, photoFile, readUpload];

// A checked photo ({ bytes, mime }) as it's kept, scaled down to the
// server's OMNIFILTER_KEEP_MAX_SIDE if there is one.
function keptPhoto(photo) {
  return imageCodec.stored(photo, { maxSide: settings.read().keepMaxSide });
}

// Saves a photo, after applying either one filter ({ tOption, params }) or a
// stack of them ({ stack: [{ tOption, params, amount, blend }, ...] }). With
// neither, the photo is saved as it is.
contentRouter.post('/newcontent', keepingPhoto, async (req, res) => {
  const recipe = readRecipe(req.body);
  if (recipe.error) return res.status(400).json({ msg: recipe.error });
  if (recipe.layers && !serverMayFilter(res, false)) return;

  const photo = await transformPhoto(req, res, recipe, {
    queue: transforms,
    key: String(req.user._id)
  });
  if (photo === undefined) return;

  const data = await Content.create(Object.assign({
    user_id: req.user._id,
    tOption: recipe.tOption,
    tParams: recipe.tParams,
    tStack: recipe.tStack
  }, await keptPhoto(photo)));
  res.status(200).json(data);
});

// Guest mode: anyone can try the filters without an account. Their photos
// aren't saved here (the page keeps them in the browser), and since anyone
// can call this, guests get a smaller share of the server: one transform at
// a time each and one for all guests together, a few a minute per IP address
// (set TRUST_PROXY behind a proxy, so that's the visitor's address), and a
// smaller photo size (16 megapixels takes a 12-megapixel phone photo; the page
// scales down bigger ones first). OMNIFILTER_GUESTS=off turns it off, and
// =device has guests filter on their own GPU (lib/settings.js).
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

// How this server is set up (lib/settings.js), for the page: where filters
// run, for signed-in users and for guests, how many photos an account may
// keep, and the largest photos it takes.
contentRouter.get('/settings', (req, res) => {
  const s = settings.read();
  res.status(200).json({
    mode: s.mode,
    processing: s.processing,
    guests: s.guests,
    maxStoredPhotos: s.maxStoredPhotos,
    keepMaxSide: s.keepMaxSide,
    maxPixels: imageCodec.MAX_PIXELS,
    guestMaxPixels: Math.min(GUEST_MAX_PIXELS, imageCodec.MAX_PIXELS)
  });
});

// Applies filters as /newcontent does, but saves nothing: replies with the
// photo and what was applied, in the shape of a saved photo without an _id.
contentRouter.post('/transform', (req, res, next) => {
  if (serverMayFilter(res, true)) next();
}, guestLimiter, photoParser, photoFile, readUpload, async (req, res) => {
  const recipe = readRecipe(req.body);
  if (recipe.error) return res.status(400).json({ msg: recipe.error });
  if (!recipe.layers) return res.status(400).json({ msg: 'Choose a filter to apply' });

  const photo = await transformPhoto(req, res, recipe, {
    queue: guestTransforms,
    key: 'guest:' + rateLimit.clientKey(req.ip),
    maxPixels: GUEST_MAX_PIXELS,
    guest: true
  });
  if (photo === undefined) return;
  res.status(200).json({
    tOption: recipe.tOption,
    tParams: recipe.tParams,
    tStack: recipe.tStack,
    content: 'data:' + photo.mime + ';base64,' + photo.bytes.toString('base64'),
    createdAt: new Date()
  });
});

// Saves a photo made elsewhere, with the filters it says it was made with:
// one made before signing in (by /transform, kept in the browser), or one
// the browser filtered on the visitor's own GPU. The photo is checked as one
// saved without a filter is; the filters are only a description, so they're
// checked to be real but not applied.
contentRouter.post('/import', keepingPhoto, async (req, res) => {
  const recipe = readRecipe(req.body);
  if (recipe.error) return res.status(400).json({ msg: recipe.error });

  var photo;
  try {
    photo = await imageCodec.validatePhoto(req.photo);
  } catch (e) {
    if (!e.status) throw e;
    return res.status(e.status).json({ msg: e.message });
  }
  const made = new Date(req.body.createdAt);
  const data = await Content.create(Object.assign({
    user_id: req.user._id,
    tOption: recipe.tOption,
    tParams: recipe.tParams,
    tStack: recipe.tStack,
    // When it was made, if that's believable.
    createdAt: made.getTime() > 0 && made <= new Date() ? made : new Date()
  }, await keptPhoto(photo)));
  res.status(200).json(data);
});

contentRouter.delete('/delete/:id', jwtAuth, validId, (req, res) => {
  Content.deleteOne({ _id: req.params.id, user_id: req.user._id })
    .then((result) => {
      if (!result.deletedCount) return res.status(404).json({ msg: 'No such content' });
      res.status(200).json({ msg: 'Successfully deleted content' });
    })
    .catch((err) => handleDBError(err, res));
});
