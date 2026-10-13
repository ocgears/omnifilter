'use strict';

// 3D colour lookup tables (LUTs). A LUT is a size^3 cube of output colours,
// one per input colour on an evenly spaced grid; the lut3d kernel reads it
// from a 3D texture so the hardware interpolates between entries.
// Tables are Float32Arrays of RGBA, red varying fastest, then green, then
// blue (the same order as .cube files). domain is the input colour at the
// cube's first and last entries, [rMin, gMin, bMin, rMax, gMax, bMax].

const DEFAULT_DOMAIN = [0, 0, 0, 1, 1, 1];

const fs = require('fs');
const path = require('path');

// Builds a LUT by evaluating fn([r, g, b]) -> [r, g, b] on the grid.
function bake(fn, size) {
  size = size || 33;
  const table = new Float32Array(size * size * size * 4);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const out = fn([r / (size - 1), g / (size - 1), b / (size - 1)]);
        const o = ((b * size + g) * size + r) * 4;
        for (let c = 0; c < 3; c++) table[o + c] = Math.min(1, Math.max(0, out[c]));
        table[o + 3] = 1;
      }
    }
  }
  return { size: size, table: table, domain: DEFAULT_DOMAIN };
}

// Parses an Adobe/Resolve .cube file (3D LUTs only). DOMAIN_MIN and
// DOMAIN_MAX give the range of input colours the cube spans; the entries are
// output colours, used as they are (clamped to 0-1).
function parseCube(text) {
  let size = 0;
  let title = null;
  let min = [0, 0, 0];
  let max = [1, 1, 1];
  const values = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const parts = line.split(/\s+/);
    const key = parts[0].toUpperCase();
    if (key === 'TITLE') title = line.slice(5).trim().replace(/^"|"$/g, '');
    else if (key === 'LUT_3D_SIZE') size = parseInt(parts[1], 10);
    else if (key === 'LUT_1D_SIZE') throw new Error('1D LUTs are not supported');
    else if (key === 'DOMAIN_MIN') min = parts.slice(1, 4).map(Number);
    else if (key === 'DOMAIN_MAX') max = parts.slice(1, 4).map(Number);
    else if (/^[-+.\d]/.test(parts[0])) {
      if (parts.length < 3) throw new Error('Bad LUT data line: ' + line);
      values.push(parts.slice(0, 3).map(Number));
    }
  }
  if (!(size >= 2 && size <= 65)) throw new Error('LUT_3D_SIZE must be between 2 and 65');
  for (let c = 0; c < 3; c++) {
    if (!(Number.isFinite(min[c]) && Number.isFinite(max[c]) && max[c] > min[c])) {
      throw new Error('DOMAIN_MAX must be above DOMAIN_MIN for every channel');
    }
  }
  if (values.length !== size * size * size) {
    throw new Error('Expected ' + size * size * size + ' LUT entries, found ' + values.length);
  }
  const table = new Float32Array(values.length * 4);
  values.forEach((v, i) => {
    for (let c = 0; c < 3; c++) {
      if (!Number.isFinite(v[c])) throw new Error('Bad LUT value: ' + v.join(' '));
      table[i * 4 + c] = Math.min(1, Math.max(0, v[c]));
    }
    table[i * 4 + 3] = 1;
  });
  return { size: size, table: table, title: title, domain: min.concat(max) };
}

function loadCube(path) {
  return parseCube(fs.readFileSync(path, 'utf8'));
}

// Loads every .cube file in a directory, as [{ name, base, file, table }]
// sorted by file name, where name is a filter name ('lut_' and the file name
// in lower case, other characters as underscores). Files that would get the
// same name ("My LUT.cube", "my_lut.cube") are numbered (lut_my_lut_2), and
// files that can't be parsed are skipped, with a message either way, so a
// stray file can't stop the server.
function loadCubeDir(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /\.cube$/i.test(f)).sort();
  } catch (e) {
    return [];
  }
  const taken = new Set();
  const cubes = [];
  for (const file of files) {
    const base = file.replace(/\.cube$/i, '');
    let table;
    try {
      table = loadCube(path.join(dir, file));
    } catch (e) {
      console.log('Skipping LUT ' + file + ': ' + e.message);
      continue;
    }
    const wanted = 'lut_' + base.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    let name = wanted;
    for (let n = 2; taken.has(name); n++) name = wanted + '_' + n;
    if (name !== wanted) console.log('LUT ' + file + ' is listed as ' + name + ', as ' + wanted + ' is taken');
    taken.add(name);
    cubes.push({ name: name, base: base, file: file, table: table });
  }
  return cubes;
}

module.exports = { bake: bake, parseCube: parseCube, loadCube: loadCube, loadCubeDir: loadCubeDir };
