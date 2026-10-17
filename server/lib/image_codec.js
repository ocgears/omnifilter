'use strict';

// Converts between the base64 data URLs the client sends and the raw RGBA
// pixels the GPU filters work on. Decoding and encoding are done by sharp
// (libvips), which runs off the main thread so large photos don't block the
// server.
//
// Errors these functions reject with carry a status (400 or 413) and a short
// message that is safe to show the client; libvips' own error text, which
// can be long and internal, is only logged.

const sharp = require('./sharp');

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

const tooManyPixels = (maxPixels) =>
  codecError(400, 'images can be at most ' + maxPixels / 1e6 + ' megapixels');

function readError(err, maxPixels) {
  if (err.status) return err;
  if (/pixel limit/.test(err.message)) return tooManyPixels(maxPixels || MAX_PIXELS);
  console.log('Could not decode an image: ' + err.message);
  return codecError(400, UNREADABLE);
}

// Whether a string looks like an image data URL (without decoding it).
exports.isImageDataUrl = (value) => typeof value === 'string' && DATA_URL.test(value);

// A data URL's bytes, or an Error with a status for the client.
function bytesOf(dataUrl) {
  const match = typeof dataUrl === 'string' && DATA_URL.exec(dataUrl);
  if (!match) throw codecError(400, 'Expected a base64 image data URL');
  return Buffer.from(dataUrl.slice(match[0].length), 'base64');
}
exports.bytesOf = bytesOf;

const toDataUrl = (photo) => 'data:' + photo.mime + ';base64,' + photo.bytes.toString('base64');

// The most bytes of photo that are saved: what a data URL of
// MAX_DATA_URL_LENGTH holds (MongoDB documents can be at most 16 MiB).
const maxBytes = () => Math.floor(exports.MAX_DATA_URL_LENGTH / 4) * 3;

// Reads just the header of a photo's bytes: checks the format and size
// limits (maxPixels, or MAX_PIXELS). Resolves with { sharp, meta, bytes }.
function inspect(bytes, maxPixels) {
  const limit = Math.min(maxPixels || MAX_PIXELS, MAX_PIXELS);
  if (!Buffer.isBuffer(bytes) || !bytes.length) return Promise.reject(codecError(400, 'No image was sent'));
  var image;
  try {
    image = sharp(bytes, { limitInputPixels: limit });
  } catch (e) {
    return Promise.reject(readError(e, limit));
  }
  return image.metadata().then((meta) => {
    if (!PHOTO_FORMATS.includes(meta.format)) {
      if (meta.format) console.log('Refused an image in ' + meta.format + ' format');
      throw codecError(400, UNREADABLE + ': send a JPEG, PNG, WebP, GIF, TIFF or AVIF photo');
    }
    if (Math.max(meta.width, meta.height) > MAX_SIDE) {
      throw codecError(400, 'images can be at most ' + MAX_SIDE + ' pixels wide or tall');
    }
    if (meta.width * meta.height > limit) throw tooManyPixels(limit);
    return { sharp: image, meta: meta, bytes: bytes };
  }, (err) => {
    throw readError(err, limit);
  });
}

// Checks a photo that is to be saved as it was sent: an allowed format,
// within the size limits (maxPixels, if given, being lower than MAX_PIXELS),
// one a browser can show, and small enough to store. Resolves with
// { bytes, mime }, the type being what the bytes really are.
exports.validatePhoto = function(bytes, maxPixels) {
  return inspect(bytes, maxPixels).then((found) => {
    const meta = found.meta;
    const avif = meta.format === 'heif' && meta.compression === 'av1';
    const mime = avif ? 'image/avif' : BROWSER_FORMATS[meta.format];
    if (!mime) {
      throw codecError(400, 'Photos saved without a filter must be JPEG, PNG, WebP, GIF or AVIF');
    }
    if (bytes.length > maxBytes()) throw codecError(413, 'The photo is too large to save');
    return { bytes: bytes, mime: mime };
  });
};

// The same for a data URL; resolves with the data URL, its type corrected.
exports.validateDataUrl = function(dataUrl) {
  try {
    return exports.validatePhoto(bytesOf(dataUrl)).then(toDataUrl);
  } catch (e) {
    return Promise.reject(e);
  }
};

// Resolves with { mime, width, height, data } where data is width * height * 4
// bytes of RGBA. mime is the format the result should be saved in: JPEGs stay
// JPEGs, and anything else (PNG, WebP, GIF, ...) becomes a PNG so transparency
// survives. Rejects if the bytes aren't an allowed image sharp can decode,
// or have more than options.maxPixels pixels (at most MAX_PIXELS).
exports.decode = function(bytes, options) {
  const maxPixels = options && options.maxPixels;
  return inspect(bytes, maxPixels).then((found) => found.sharp
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
      throw readError(err, maxPixels);
    }));
};

exports.decodeDataUrl = function(dataUrl, options) {
  try {
    return exports.decode(bytesOf(dataUrl), options);
  } catch (e) {
    return Promise.reject(e);
  }
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
  return ENCODERS[mime](pipeline, quality).toBuffer().then((bytes) => ({ bytes: bytes, mime: mime }));
}

// Inverse of decode(): resolves with { bytes, mime }. If the result would be
// too big to save (a PNG of a large photo can be ten times the size of the
// WebP it came from), falls back to lossy encodings: JPEG if the image is
// fully opaque, else WebP, which keeps the transparency. Rejects with a 413
// if even those are too big.
exports.encode = function(image) {
  const limit = maxBytes();
  return encodeAs(image, image.mime).then((first) => {
    if (first.bytes.length <= limit) return first;
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
            .then((out) => (out.bytes.length <= limit ? out : next(i + 1)), () => next(i + 1));
        };
        return next(0);
      });
  });
};

exports.encodeDataUrl = (image) => exports.encode(image).then(toDataUrl);

// The gallery's copy of a photo: this many pixels on its longer side (sharp
// on a 2x screen at the gallery's widest cards), as a WebP.
const THUMB_SIDE = 640;
exports.THUMB_SIDE = THUMB_SIDE;

// A photo as it's kept (models/content.js), from bytes and their type as
// validatePhoto or encode give them: { image, mime, width, height, thumb },
// with its bytes, their type, its size as shown (EXIF orientation applied)
// and a thumbnail as a WebP data URL.
//
// With options.maxSide, the photo is drawn again, scaled down to that if it
// is longer on either side, and kept as a JPEG, or a WebP if it has
// transparency. Being drawn again leaves behind its metadata (where it was
// taken, and the camera) and anything else the file carried, so a small
// photo padded out to megabytes is kept at the size of its pixels. Without
// it, the photo is kept as it came.
exports.stored = function(photo, options) {
  const maxSide = options && options.maxSide;
  const original = photo.bytes;
  const read = (bytes) => sharp(bytes, { limitInputPixels: MAX_PIXELS });
  return read(original).metadata().then((meta) => {
    // Orientations 5 to 8 turn the photo on its side.
    const sideways = meta.orientation >= 5;
    const width = sideways ? meta.height : meta.width;
    const height = sideways ? meta.width : meta.height;
    if (!maxSide) return { image: original, mime: photo.mime, width: width, height: height };
    const drawn = read(original).rotate()
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true });
    const encoded = meta.hasAlpha ?
      drawn.webp({ quality: 90, alphaQuality: 100 }) : drawn.jpeg({ quality: JPEG_QUALITY });
    return encoded.toBuffer({ resolveWithObject: true }).then((out) => ({
      image: out.data,
      mime: meta.hasAlpha ? 'image/webp' : 'image/jpeg',
      width: out.info.width,
      height: out.info.height
    }));
  }).then((kept) => read(kept.image).rotate()
    .resize({ width: THUMB_SIDE, height: THUMB_SIDE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 75 })
    .toBuffer()
    .then((thumb) => Object.assign(kept, { thumb: 'data:image/webp;base64,' + thumb.toString('base64') })))
    .catch((err) => {
      throw readError(err);
    });
};

// The same from a data URL.
exports.toStored = function(dataUrl, options) {
  const match = typeof dataUrl === 'string' && DATA_URL.exec(dataUrl);
  if (!match) return Promise.reject(codecError(400, 'Expected a base64 image data URL'));
  return exports.stored({ bytes: bytesOf(dataUrl), mime: match[1] }, options);
};
