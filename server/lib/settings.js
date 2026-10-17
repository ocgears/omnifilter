'use strict';

// How this server is set up to be used, from its environment. Read on every
// request (it's cheap), so tests can change the environment.
//
//   OMNIFILTER_MODE=cloud            the hosted demo: everything below at its
//                                    cloud value, unless set separately
//   OMNIFILTER_PROCESSING            where signed-in users' filters run:
//     server (default)               here, on this server's GPU (or CPU)
//     device                         on the visitor's own GPU, in the
//                                    browser; this server only keeps results
//     device-first                   on the visitor's GPU when the browser
//                                    can, otherwise here
//   OMNIFILTER_GUESTS                guests (no account):
//     server (default; also on)      may use this server's filters
//     device                         filter on their own GPU only
//     off (also false, 0, no)        can't use the page without signing in
//   OMNIFILTER_MAX_STORED_PHOTOS     how many photos each account may keep
//                                    (default: no limit; cloud: 5)
//   OMNIFILTER_KEEP_MAX_SIDE         kept photos longer than this many pixels
//                                    on a side are kept scaled down to it
//                                    (default: kept as they are; cloud: 2048,
//                                    so a free database holds a few hundred);
//                                    with a size set, every kept photo is
//                                    drawn again, which leaves behind its
//                                    metadata (where it was taken) and
//                                    anything else the file carried
//   OMNIFILTER_KEEP_MAX_PIXELS       the largest photo taken in to keep, in
//                                    pixels (default: the server's pixel
//                                    limit; cloud: 16 million). The page
//                                    scales photos down to the kept size
//                                    first, so this only turns away ones
//                                    sent some other way, which would take a
//                                    lot of this server's memory to read
//   OMNIFILTER_KEEP_MAX_BYTES        the most bytes a kept photo, as drawn
//                                    again, may take (default: no limit;
//                                    cloud: 3 MB, ten times a typical photo
//                                    at 2048 px). One over it is tried again
//                                    at a lower quality, then turned away
//   OMNIFILTER_SIGNUPS_PER_DAY       accounts made per day from one address
//                                    (an IPv6 /48) (default: no limit;
//                                    cloud: 10)
//   OMNIFILTER_MAX_DATA_MB           photos aren't kept once the database
//                                    holds this many megabytes (default: no
//                                    limit; cloud: 400, under the free
//                                    MongoDB Atlas cluster's 512)

const CLOUD = { processing: 'device', guests: 'device', maxStoredPhotos: 5, keepMaxSide: 2048,
  keepMaxPixels: 16e6, keepMaxBytes: 3e6, signupsPerDay: 10, maxDataMB: 400 };
const PROCESSING = ['server', 'device', 'device-first'];

function read(env) {
  const e = env || process.env;
  const cloud = /^cloud$/i.test((e.OMNIFILTER_MODE || '').trim());
  const fallback = (key) => (cloud ? CLOUD[key] : undefined);

  let processing = (e.OMNIFILTER_PROCESSING || '').trim().toLowerCase();
  if (!PROCESSING.includes(processing)) processing = fallback('processing') || 'server';

  const g = (e.OMNIFILTER_GUESTS || '').trim().toLowerCase();
  let guests;
  if (/^(off|false|0|no)$/.test(g)) guests = 'off';
  else if (g === 'device') guests = 'device';
  else if (/^(server|on|true|1|yes)$/.test(g)) guests = 'server';
  else guests = fallback('guests') || 'server';

  // A positive number from the environment, or the cloud value, or null.
  const limit = (name, key, parse) => {
    const n = parse(e[name]);
    return n > 0 ? n : fallback(key) || null;
  };
  const whole = (v) => parseInt(v, 10);

  return {
    mode: cloud ? 'cloud' : 'standard',
    processing: processing,
    guests: guests,
    maxStoredPhotos: limit('OMNIFILTER_MAX_STORED_PHOTOS', 'maxStoredPhotos', whole),
    keepMaxSide: limit('OMNIFILTER_KEEP_MAX_SIDE', 'keepMaxSide', whole),
    keepMaxPixels: limit('OMNIFILTER_KEEP_MAX_PIXELS', 'keepMaxPixels', Number),
    keepMaxBytes: limit('OMNIFILTER_KEEP_MAX_BYTES', 'keepMaxBytes', Number),
    signupsPerDay: limit('OMNIFILTER_SIGNUPS_PER_DAY', 'signupsPerDay', whole),
    maxDataMB: limit('OMNIFILTER_MAX_DATA_MB', 'maxDataMB', Number)
  };
}

// Whether this server runs filters for a signed-in user, or for a guest.
const serverFilters = (s) => s.processing !== 'device';
const guestServerFilters = (s) => s.guests === 'server';
// Whether this server runs filters for anyone, and so needs a device.
const serverDevice = (s) => serverFilters(s) || guestServerFilters(s);

module.exports = {
  read: read,
  serverFilters: serverFilters,
  guestServerFilters: guestServerFilters,
  serverDevice: serverDevice
};
