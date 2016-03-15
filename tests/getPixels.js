'use strict';

const Pixel = require('pixel-class');

module.exports = exports = function getPixels (image) {

  let pixels = [],
  let height = image.height(),
  let width = image.width(),
  let cRow = [];

  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) {
      cRow.push(new Pixel(image.getPixel(x, y)));
    }
    pixels.push(cRow);
    cRow = [];
  }

  return pixels;
};
