'use strict';

// Every kernel with a WebGPU version, by its OpenCL name.
module.exports = Object.assign({},
  require('./colour').COLOUR,
  require('./convolve').CONVOLVE,
  require('./stylize').STYLIZE,
  require('./retro').RETRO,
  require('./adjust').ADJUST,
  require('./generative').GENERATIVE,
  require('./resize').RESIZE);
