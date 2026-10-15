'use strict';

// Any .cube files in server/luts/, as looks (see looks.js).

const path = require('path');
const { lutFilter } = require('./looks');
const { loadCubeDir } = require('./lut_files');

const LUT_DIR = path.join(__dirname, '..', '..', 'luts');

module.exports = loadCubeDir(LUT_DIR).map((c) =>
  lutFilter(c.name, c.table.title || c.base, 'Your LUT from server/luts/' + c.file + '.', c.table));
