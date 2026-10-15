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

const CLOUD = { processing: 'device', guests: 'device', maxStoredPhotos: 5 };
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

  const max = parseInt(e.OMNIFILTER_MAX_STORED_PHOTOS, 10);
  const maxStoredPhotos = max > 0 ? max : fallback('maxStoredPhotos') || null;

  return {
    mode: cloud ? 'cloud' : 'standard',
    processing: processing,
    guests: guests,
    maxStoredPhotos: maxStoredPhotos
  };
}

// Whether this server runs filters for a signed-in user, or for a guest.
const serverFilters = (s) => s.processing !== 'device';
const guestServerFilters = (s) => s.guests === 'server';

module.exports = {
  read: read,
  serverFilters: serverFilters,
  guestServerFilters: guestServerFilters
};
