'use strict';

// Converts between the base64 data URLs the client sends and the raw RGBA
// pixels the GPU filters work on. Decoding and encoding are done by sharp
// (libvips), which runs off the main thread so large photos don't block the
// server.
//
// Errors these functions reject with carry a status (400 or 413) and a short
// message that is safe to show the client; libvips' own error text, which
// can be long and internal, is only logged.

const sharp = require('sharp');

const JPEG_QUALITY = 90;

// A small compressed file can expand to gigabytes of pixels (a "decompression
// bomb"), so images are limited by pixel count and by side length. sharp
// checks the pixel count from the file header, before decoding anything.
// 50 megapixels covers phone and most camera photos; raise it with
// OMNIFILTER_MAX_PIXELS if the GPU has the memory.
const MAX_PIXELS = Number(process.env.OMNIFILTER_MAX_PIXELS) || 50e6;
// Very long images are refused too. (Filters that need textures larger than
// the device allows run on a scaled-down copy; see gpu_filters.js.)
const MAX_SIDE = 16384;

exports.MAX_PIXELS = MAX_PIXELS;
exports.MAX_SIDE = MAX_SIDE;

// The longest data URL that's saved. A MongoDB document can be at most 16 MiB,
// and the rest of the photo's fields need a little room. (Read at call time,
// so tests can lower it.)
exports.MAX_DATA_URL_LENGTH = 15 * 1024 * 1024;

const DATA_URL = /^data:(image\/[\w.+-]+);base64,/;

// Photo formats that are accepted, by the name sharp's metadata gives them.
// sharp goes by the bytes, not the data URL's type, so this is what stops an
// SVG, PDF or camera raw file sent as "image/jpeg" from reaching libvips'
// loaders for those. AVIF and HEIC both report 'heif'.
const PHOTO_FORMATS = ['jpeg', 'png', 'webp', 'gif', 'tiff', 'heif'];

// The ones browsers can show, so a photo saved without a filter can be kept as
// it was sent. (HEIF is allowed only when it is AVIF.)
const BROWSER_FORMATS = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

function codecError(status, msg) {
  const err = new Error(msg);
  err.status = status;
  return err;
}

const UNREADABLE = 'Unsupported or corrupt image';

function readError(err) {
  if (err.status) return err;
  if (/pixel limit/.test(err.message)) {
    return codecError(400, 'images can be at most ' + MAX_PIXELS / 1e6 + ' megapixels');
  }
  console.log('Could not decode an image: ' + err.message);
  return codecError(400, UNREADABLE);
}

// Whether a string looks like an image data URL (without decoding it).
exports.isImageDataUrl = (value) => typeof value === 'string' && DATA_URL.test(value);

// Reads just the header: checks the format and size limits. Resolves with
// { sharp, meta, bytes }.
function inspect(dataUrl) {
  const match = typeof dataUrl === 'string' && DATA_URL.exec(dataUrl);
  if (!match) {
    return Promise.reject(codecError(400, 'Expected a base64 image data URL'));
  }
  const bytes = Buffer.from(dataUrl.slice(match[0].length), 'base64');
  var image;
  try {
    image = sharp(bytes, { limitInputPixels: MAX_PIXELS });
  } catch (e) {
    return Promise.reject(readError(e));
  }
  return image.metadata().then((meta) => {
    if (!PHOTO_FORMATS.includes(meta.format)) {
      if (meta.format) console.log('Refused an image in ' + meta.format + ' format');
      throw codecError(400, UNREADABLE + ': send a JPEG, PNG, WebP, GIF, TIFF or AVIF photo');
    }
    if (Math.max(meta.width, meta.height) > MAX_SIDE) {
      throw codecError(400, 'images can be at most ' + MAX_SIDE + ' pixels wide or tall');
    }
    if (meta.width * meta.height > MAX_PIXELS) {
      throw codecError(400, 'images can be at most ' + MAX_PIXELS / 1e6 + ' megapixels');
    }
    return { sharp: image, meta: meta, bytes: bytes };
  }, (err) => {
    throw readError(err);
  });
}

// Checks a photo that is to be saved as it was sent: an allowed format,
// within the size limits, one a browser can show, and small enough to store.
// Resolves with the data URL, its type corrected to what the bytes really
// are.
exports.validateDataUrl = function(dataUrl) {
  return inspect(dataUrl).then((found) => {
    const meta = found.meta;
    const mime = meta.format === 'heif' ?
      (meta.compression === 'av1' ? 'image/avif' : null) : BROWSER_FORMATS[meta.format];
    if (!mime) {
      throw codecError(400, 'Photos saved without a filter must be JPEG, PNG, WebP, GIF or AVIF');
    }
    const out = 'data:' + mime + ';base64,' + found.bytes.toString('base64');
    if (out.length > exports.MAX_DATA_URL_LENGTH) {
      throw codecError(413, 'The photo is too large to save');
    }
    return out;
  });
};

// Resolves with { mime, width, height, data } where data is width * height * 4
// bytes of RGBA. mime is the format the result should be saved in: JPEGs stay
// JPEGs, and anything else (PNG, WebP, GIF, ...) becomes a PNG so transparency
// survives. Rejects if the data URL isn't an allowed image sharp can decode.
exports.decodeDataUrl = function(dataUrl) {
  return inspect(dataUrl).then((found) => found.sharp
    .rotate() // apply the EXIF orientation, so phone photos stay upright
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then((result) => ({
      mime: found.meta.format === 'jpeg' ? 'image/jpeg' : 'image/png',
      width: result.info.width,
      height: result.info.height,
      data: result.data
    }), (err) => {
      throw readError(err);
    }));
};

const ENCODERS = {
  'image/jpeg': (pipeline, quality) => pipeline.jpeg({ quality: quality || JPEG_QUALITY }),
  'image/png': (pipeline) => pipeline.png(),
  'image/webp': (pipeline, quality) => pipeline.webp({ quality: quality, alphaQuality: 100 })
};

function encodeAs(image, mime, quality) {
  const pipeline = sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 4 }
  });
  return ENCODERS[mime](pipeline, quality).toBuffer()
    .then((bytes) => 'data:' + mime + ';base64,' + bytes.toString('base64'));
}

// Inverse of decodeDataUrl. If the result would be too big to save (a PNG of
// a large photo can be ten times the size of the WebP it came from), falls
// back to lossy encodings: JPEG if the image is fully opaque, else WebP, which
// keeps the transparency. Rejects with a 413 if even those are too big.
exports.encodeDataUrl = function(image) {
  const limit = exports.MAX_DATA_URL_LENGTH;
  return encodeAs(image, image.mime).then((first) => {
    if (first.length <= limit) return first;
    return sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } })
      .stats()
      .then((stats) => {
        const fallbacks = stats.isOpaque ?
          [['image/jpeg', JPEG_QUALITY], ['image/jpeg', 75]] :
          [['image/webp', 90], ['image/webp', 75]];
        const next = (i) => {
          if (i === fallbacks.length) {
            throw codecError(413, 'The filtered photo is too large to save; try a smaller image');
          }
          // A JPEG that was already too big at this quality will be again.
          if (fallbacks[i][0] === image.mime && fallbacks[i][1] === JPEG_QUALITY) return next(i + 1);
          // (WebP can't encode images more than 16383 pixels wide or tall.)
          return encodeAs(image, fallbacks[i][0], fallbacks[i][1])
            .then((url) => (url.length <= limit ? url : next(i + 1)), () => next(i + 1));
        };
        return next(0);
      });
  });
};
