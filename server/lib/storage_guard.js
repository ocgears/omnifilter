'use strict';

// Whether the database has room for another photo (OMNIFILTER_MAX_DATA_MB).
// A free MongoDB Atlas cluster stops taking writes at 512 MB, sign-ins and
// settings changes included, so photos stop being kept well before that.
// The database's size (its data and indexes, before compression) is asked
// for at most once a minute, and photos kept in between are added to it.

const mongoose = require('mongoose');
const settings = require('./settings');

const ASK_EVERY_MS = 60000;
var known = null; // { bytes, at }
var asking = null;

function usedBytes() {
  if (known && Date.now() - known.at < ASK_EVERY_MS) return Promise.resolve(known.bytes);
  if (!asking) {
    asking = mongoose.connection.db.stats().then((stats) => {
      known = { bytes: stats.dataSize + stats.indexSize, at: Date.now() };
      return known.bytes;
    }).finally(() => {
      asking = null;
    });
  }
  return asking;
}

// Middleware: replies 507 when the database is full.
exports.roomInDatabase = async (req, res, next) => {
  const maxMB = settings.read().maxDataMB;
  if (!maxMB) return next();
  var used;
  try {
    used = await usedBytes();
  } catch (e) {
    // Better to keep the photo than to turn everyone away while the
    // database can't say how big it is.
    console.log('Could not read the database\'s size: ' + e.message);
    return next();
  }
  if (used < maxMB * 1e6) return next();
  console.log('The database holds ' + Math.round(used / 1e6) + ' MB, over OMNIFILTER_MAX_DATA_MB; not keeping photos');
  res.status(507).json({ msg: 'This server has no room for more photos just now; you can still save yours' });
};

// After a photo of `bytes` is kept.
exports.added = (bytes) => {
  if (known) known.bytes += bytes;
};

// Forgets the size, so the next photo asks for it (for tests).
exports.reset = () => {
  known = null;
};
