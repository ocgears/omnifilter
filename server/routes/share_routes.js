'use strict';

// Sharing a kept photo by a link anyone can open, which its owner turns on
// and off photo by photo:
//
//   POST   /content/:id/share   (signed in) gives the photo a public address,
//                               or tells it the one it has: { shareId }
//   DELETE /content/:id/share   (signed in) takes it away again
//   GET    /p/:shareId          a small page showing the photo, with the tags
//                               chat apps and social sites read for a preview
//   GET    /p/:shareId/photo    the photo itself
//
// The address is 128 random bits, so a photo is seen only by those given its
// link; the page asks search engines not to list it. The page runs no
// scripts. OMNIFILTER_SHARING=off turns all of this off.

const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const Content = require(__dirname + '/../models/content');
const jwtAuth = require(__dirname + '/../lib/jwt_auth');
const gpuFilters = require(__dirname + '/../lib/gpu_filters');
const settings = require(__dirname + '/../lib/settings');
const handleDBError = require(__dirname + '/../lib/handle_db_error');
const { EXTENSIONS, keptFile } = require(__dirname + '/../lib/kept_photo');

const router = module.exports = exports = express.Router();

// 16 random bytes in base64url.
const SHARE_ID = /^[A-Za-z0-9_-]{22}$/;
const newShareId = () => crypto.randomBytes(16).toString('base64url');

// Its owner can stop sharing a photo at any moment, so browsers check back
// every time (Express's ETags make that a short 304 when nothing changed).
const PUBLIC_CACHE = 'no-cache';

function sharingOn(res) {
  if (settings.read().sharing) return true;
  res.status(403).json({ msg: 'This server doesn\'t share photos by link' });
  return false;
}

const ownPhoto = (req) => ({ _id: req.params.id, user_id: req.user._id });

const validId = (req, res, next) => {
  if (!mongoose.isObjectIdOrHexString(req.params.id)) return res.status(404).json({ msg: 'No such photo' });
  next();
};

router.post('/content/:id/share', jwtAuth, validId, async (req, res) => {
  if (!sharingOn(res)) return;
  try {
    // Only if it has no address yet: asking twice gives the same link.
    const found = await Content.findOneAndUpdate(
      Object.assign(ownPhoto(req), { shareId: mongoose.trusted({ $exists: false }) }),
      { $set: { shareId: newShareId(), sharedAt: new Date() } },
      { returnDocument: 'after', projection: { shareId: 1 } }
    ) || await Content.findOne(ownPhoto(req)).select('shareId');
    if (!found) return res.status(404).json({ msg: 'No such photo' });
    res.status(200).json({ shareId: found.shareId });
  } catch (err) {
    handleDBError(err, res);
  }
});

router.delete('/content/:id/share', jwtAuth, validId, async (req, res) => {
  try {
    const result = await Content.updateOne(ownPhoto(req), { $unset: { shareId: 1, sharedAt: 1 } });
    if (!result.matchedCount) return res.status(404).json({ msg: 'No such photo' });
    res.status(200).json({ msg: 'The link no longer works' });
  } catch (err) {
    handleDBError(err, res);
  }
});

// The shared photo with this address, or null.
async function sharedPhoto(shareId) {
  if (!settings.read().sharing || !SHARE_ID.test(shareId)) return null;
  return Content.findOne({ shareId: shareId });
}

// What the photo had applied, e.g. "Sepia + Vignette", like the page's
// gallery says.
function recipeLabel(photo) {
  const labels = new Map(gpuFilters.list().map((f) => [f.name, f.label]));
  const label = (name) => labels.get(name) || name || 'Original';
  return photo.tStack && photo.tStack.length ?
    photo.tStack.map((layer) => label(layer.tOption)).join(' + ') :
    label(photo.tOption);
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]);

const PAGE_STYLE = `
  :root { color-scheme: light dark; --bg: #f6f7f9; --text: #15171a; --muted: #5b6270; --accent: #2557d6; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #14161a; --text: #eceef2; --muted: #a3a9b5; --accent: #9bb9ff; }
  }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 64rem; margin: 0 auto; padding: 1rem; }
  figure { margin: 0; }
  img { display: block; max-width: 100%; height: auto; max-height: 80vh; margin: 0 auto; border-radius: 8px; }
  figcaption { margin-top: 0.75rem; text-align: center; color: var(--muted); }
  a { color: var(--accent); }
  .make { display: block; width: fit-content; margin: 1.25rem auto; padding: 0.75rem 1.25rem;
    border-radius: 8px; background: var(--accent); color: var(--bg); font-weight: 600; text-decoration: none; }
  .make:focus-visible { outline: 3px solid var(--text); outline-offset: 2px; }
`;

function page(title, head, body) {
  return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="robots" content="noindex">\n' +
    '<title>' + escapeHtml(title) + '</title>\n' + head +
    '<link rel="icon" href="/favicon.ico">\n<style>' + PAGE_STYLE + '</style>\n</head>\n' +
    '<body>\n<main>\n' + body + '\n</main>\n</body>\n</html>\n';
}

router.get('/p/:shareId', async (req, res) => {
  res.set('X-Robots-Tag', 'noindex');
  var photo;
  try {
    photo = await sharedPhoto(req.params.shareId);
  } catch (err) {
    return handleDBError(err, res);
  }
  if (!photo) {
    res.set('Cache-Control', 'no-store');
    return res.status(404).type('html').send(page('Not shared · OmniFilter', '',
      '<h1>This photo isn\'t shared</h1>\n<p>Its owner may have stopped sharing it, or deleted it.</p>\n' +
      '<a class="make" href="/#/home">Try OmniFilter</a>'));
  }
  const label = recipeLabel(photo);
  const self = '/p/' + photo.shareId;
  // Previews need the photo's full address.
  const image = req.protocol + '://' + req.get('host') + self + '/photo';
  const size = photo.width && photo.height ?
    ' width="' + photo.width + '" height="' + photo.height + '"' : '';
  const day = photo.createdAt ? photo.createdAt.toLocaleDateString('en-GB',
    { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '';
  const head =
    '<meta name="description" content="' + escapeHtml('A photo made with OmniFilter: ' + label + '.') + '">\n' +
    '<meta property="og:type" content="website">\n' +
    '<meta property="og:site_name" content="OmniFilter">\n' +
    '<meta property="og:title" content="' + escapeHtml(label) + '">\n' +
    '<meta property="og:description" content="A photo made with OmniFilter, photo filters on the GPU.">\n' +
    '<meta property="og:image" content="' + escapeHtml(image) + '">\n' +
    (photo.width ? '<meta property="og:image:width" content="' + photo.width + '">\n' +
      '<meta property="og:image:height" content="' + photo.height + '">\n' : '') +
    '<meta name="twitter:card" content="summary_large_image">\n';
  const body =
    '<figure>\n<img src="' + escapeHtml(self + '/photo') + '"' + size +
    ' alt="' + escapeHtml('A photo with ' + label + ' applied') + '">\n' +
    '<figcaption>' + escapeHtml(label) + ', made with OmniFilter' + (day ? ' on ' + escapeHtml(day) : '') +
    '.</figcaption>\n</figure>\n<a class="make" href="/#/home">Make your own</a>';
  res.set('Cache-Control', PUBLIC_CACHE);
  res.status(200).type('html').send(page(label + ' · OmniFilter', head, body));
});

router.get('/p/:shareId/photo', async (req, res) => {
  res.set('X-Robots-Tag', 'noindex');
  var photo;
  try {
    photo = await sharedPhoto(req.params.shareId);
  } catch (err) {
    return handleDBError(err, res);
  }
  const file = photo && keptFile(photo);
  if (!file) {
    res.set('Cache-Control', 'no-store');
    return res.status(404).json({ msg: 'No such photo' });
  }
  res.set('Cache-Control', PUBLIC_CACHE);
  res.set('Content-Disposition', 'inline; filename="omnifilter-' + photo.shareId.slice(0, 6) + '.' +
    (EXTENSIONS[file.mime] || 'img') + '"');
  res.type(file.mime).send(file.bytes);
});
