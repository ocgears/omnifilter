'use strict';

// A kept photo's file: its bytes and type. Photos kept by older versions
// hold it as a data URL, read here too, but only as the types photos were
// ever kept as (not, say, an SVG, which could carry a script). null if the
// photo has no file it can be sent as.

const EXTENSIONS = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif'
};

function keptFile(photo) {
  if (photo.image) return { bytes: photo.image, mime: photo.mime };
  const legacy = typeof photo.content === 'string' && /^data:(image\/[\w.+-]+);base64,/.exec(photo.content);
  if (!legacy || !EXTENSIONS[legacy[1]]) return null;
  return { bytes: Buffer.from(photo.content.slice(legacy[0].length), 'base64'), mime: legacy[1] };
}

module.exports = { EXTENSIONS: EXTENSIONS, keptFile: keptFile };
