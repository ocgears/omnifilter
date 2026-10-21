'use strict';

// Makes the app icons (client/public/icons) that the web app manifest names:
// the logo's galaxy disc and triangle-and-diamond mark, drawn again as
// vectors (the logo itself is only 178 px, with the mark baked in).
//
//   node scripts/make-icons.js
//
// "any" icons are the round logo on a clear background; "maskable" ones
// fill the square, with the mark inside the middle 80% that Android's icon
// shapes (circle, squircle...) always show.

const path = require('path');
const sharp = require('sharp');

const OUT = path.join(__dirname, '../client/public/icons');
const INK = '#14161a';

// A galaxy's glow: a bright core fading through the logo's warm browns.
function glow(size, round) {
  const c = size / 2;
  return (
    '<defs><radialGradient id="g" cx="50%" cy="46%" r="62%">' +
    '<stop offset="0" stop-color="#fffaf1"/><stop offset="0.28" stop-color="#f1d6b8"/>' +
    '<stop offset="0.62" stop-color="#c98d5f"/><stop offset="1" stop-color="#5a3a2a"/>' +
    '</radialGradient></defs>' +
    (round
      ? `<circle cx="${c}" cy="${c}" r="${c}" fill="url(#g)"/>`
      : `<rect width="${size}" height="${size}" fill="url(#g)"/>`)
  );
}

// The mark: an upward triangle and a diamond sharing its apex, `scale` of
// the size across, centred top to bottom.
function mark(size, scale) {
  const r = (size * scale) / 2;
  const c = size / 2;
  const w = Math.max(2, size / 40);
  const pts = (list) =>
    list.map(([x, y]) => (c + x * r).toFixed(1) + ',' + (c + (y + 0.14) * r).toFixed(1)).join(' ');
  return (
    `<g fill="none" stroke="${INK}" stroke-width="${w}" stroke-linejoin="round">` +
    `<polygon points="${pts([[0, -0.92], [0.9, 0.64], [-0.9, 0.64]])}"/>` +
    `<polygon points="${pts([[0, -0.92], [0.64, -0.28], [0, 0.36], [-0.64, -0.28]])}"/>` +
    '</g>'
  );
}

function icon(size, { round, scale, file }) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    glow(size, round) +
    mark(size, scale) +
    '</svg>';
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(path.join(OUT, file));
}

(async () => {
  require('fs').mkdirSync(OUT, { recursive: true });
  for (const size of [192, 512]) {
    await icon(size, { round: true, scale: 0.72, file: `icon-${size}.png` });
    await icon(size, { round: false, scale: 0.56, file: `icon-maskable-${size}.png` });
  }
  // iOS's home screen icon: square and opaque (iOS rounds the corners).
  await icon(180, { round: false, scale: 0.64, file: 'apple-touch-icon.png' });
  console.log('Icons written to', OUT);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
