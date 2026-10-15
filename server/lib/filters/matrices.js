'use strict';

// 4x5 colour matrices for the color_matrix kernel, stored row by row as 20
// floats: each output channel (R, G, B, A) is a weighted sum of the input
// channels plus an offset, with colours from 0 to 1. The formulas follow
// the CSS / SVG filter specs (feColorMatrix).

function fromRows3(rows, offsets) {
  offsets = offsets || [0, 0, 0];
  return new Float32Array([
    rows[0][0], rows[0][1], rows[0][2], 0, offsets[0],
    rows[1][0], rows[1][1], rows[1][2], 0, offsets[1],
    rows[2][0], rows[2][1], rows[2][2], 0, offsets[2],
    0, 0, 0, 1, 0
  ]);
}

const identity = () => fromRows3([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);

// Applies b first, then a.
function multiply(a, b) {
  const out = new Float32Array(20);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 5; c++) {
      let v = c === 4 ? a[r * 5 + 4] : 0;
      for (let k = 0; k < 4; k++) v += a[r * 5 + k] * b[k * 5 + c];
      out[r * 5 + c] = v;
    }
  }
  return out;
}

function grayscale(a) {
  const k = 1 - a;
  return fromRows3([
    [0.2126 + 0.7874 * k, 0.7152 - 0.7152 * k, 0.0722 - 0.0722 * k],
    [0.2126 - 0.2126 * k, 0.7152 + 0.2848 * k, 0.0722 - 0.0722 * k],
    [0.2126 - 0.2126 * k, 0.7152 - 0.7152 * k, 0.0722 + 0.9278 * k]
  ]);
}

function sepia(a) {
  const k = 1 - a;
  return fromRows3([
    [0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k],
    [0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k],
    [0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k]
  ]);
}

function saturation(s) {
  return fromRows3([
    [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s]
  ]);
}

function hueRotate(degrees) {
  const t = degrees * Math.PI / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return fromRows3([
    [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
    [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283],
    [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072]
  ]);
}

function invert(a) {
  const d = 1 - 2 * a;
  return fromRows3([[d, 0, 0], [0, d, 0], [0, 0, d]], [a, a, a]);
}

// b from -1 to 1, added to every channel.
function brightness(b) {
  return fromRows3([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [b, b, b]);
}

// c from -1 to 1: scales distances from mid-grey.
function contrast(c) {
  const k = 1 + c;
  const o = 0.5 * (1 - k);
  return fromRows3([[k, 0, 0], [0, k, 0], [0, 0, k]], [o, o, o]);
}

// order like 'brg': output R takes input B, output G takes R, output B takes G.
function channelSwap(order) {
  const index = { r: 0, g: 1, b: 2 };
  return fromRows3(order.split('').map((ch) => [0, 1, 2].map((k) => (index[ch] === k ? 1 : 0))));
}

// Faded, warm, slightly sepia film.
function vintage(a) {
  let m = sepia(0.45 * a);
  m = multiply(contrast(-0.12 * a), m);
  m = multiply(fromRows3([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0.05 * a, 0.02 * a, -0.02 * a]), m);
  return m;
}

module.exports = {
  identity: identity,
  multiply: multiply,
  grayscale: grayscale,
  sepia: sepia,
  saturation: saturation,
  hueRotate: hueRotate,
  invert: invert,
  brightness: brightness,
  contrast: contrast,
  channelSwap: channelSwap,
  vintage: vintage
};
