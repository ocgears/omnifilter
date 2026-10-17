'use strict';

// The security headers on every reply (helmet), above all a Content Security
// Policy for the built client. The page keeps its sign-in token in
// localStorage, where any script running in the page could read it, so the
// policy only lets the page run its own scripts: no inline ones (but those
// the build itself writes into index.html, by their hash), no eval, nothing
// from other sites. It also stops other sites framing the page.
//
// The page talks to the API at its own address, or wherever its build says
// (client/src/app/api-base.ts), so that's where it may connect; it reads
// photos from data: and blob: URLs, and runs the full-size filters in a
// worker from its own address.

const crypto = require('crypto');
const fs = require('fs');
const helmet = require('helmet');

// The inline scripts in index.html (the build's stylesheet loader), as CSP
// hashes, and where the page's API is: a list of CSP sources for
// connect-src.
function readPage(indexFile) {
  var html = '';
  try {
    html = fs.readFileSync(indexFile, 'utf8');
  } catch (e) {
    // No built client: nothing inline to allow.
  }
  const hashes = [];
  for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (match[1].trim()) {
      hashes.push('\'sha256-' + crypto.createHash('sha256').update(match[1]).digest('base64') + '\'');
    }
  }
  const meta = /<meta name="omnifilter-api" content="([^"]*)"/i.exec(html);
  var api = [];
  if (!meta) {
    // The default: port 3000 of the host that served the page.
    api = ['http://*:3000', 'https://*:3000'];
  } else if (/^https?:\/\//i.test(meta[1])) {
    api = [new URL(meta[1].replace(/&amp;/g, '&')).origin];
  }
  return { hashes: hashes, api: api };
}

module.exports = exports = function securityHeaders(indexFile) {
  const page = readPage(indexFile);
  const headers = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ['\'self\''],
        'script-src': ['\'self\''].concat(page.hashes),
        // Angular adds components' styles to the page as it runs.
        'style-src': ['\'self\'', '\'unsafe-inline\''],
        'img-src': ['\'self\'', 'data:', 'blob:'],
        'media-src': ['\'self\'', 'blob:'],
        'connect-src': ['\'self\'', 'data:', 'blob:'].concat(page.api),
        'worker-src': ['\'self\''],
        'font-src': ['\'self\''],
        'object-src': ['\'none\''],
        'base-uri': ['\'self\''],
        'form-action': ['\'self\''],
        'frame-ancestors': ['\'none\'']
      }
    },
    // Photos may be shown by a page on another port or subdomain (npm start
    // runs the page on port 5000 and this on 3000).
    crossOriginResourcePolicy: { policy: 'same-site' },
    // HTTPS only, for this host; not for its subdomains, which may be other
    // people's sites.
    strictTransportSecurity: { maxAge: 31536000, includeSubDomains: false }
  });
  return (req, res, next) => {
    // The page uses the camera (the live camera), and nothing else of these.
    res.setHeader('Permissions-Policy',
      'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
    headers(req, res, next);
  };
};

exports.readPage = readPage;
