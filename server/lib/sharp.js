'use strict';

// sharp, the image library, loaded the first time a photo is read or written
// rather than when the server starts. Loading it is a noticeable part of
// starting up, which on Cloud Run happens while the first visitor after an
// idle spell waits, and the page and its settings don't need it.
let sharp = null;

module.exports = function() {
  if (!sharp) {
    sharp = require('sharp');
    // libvips keeps recent operations' results in case they're asked for
    // again, which here they never are, and a big photo's decoded pixels
    // then stay in memory after it's been kept.
    sharp.cache(false);
  }
  return sharp.apply(null, arguments);
};
