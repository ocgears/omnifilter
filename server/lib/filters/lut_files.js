'use strict';

// Reading .cube LUT files from disk (see lut.js for the format).

const fs = require('fs');
const path = require('path');
const { parseCube } = require('./lut');

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

module.exports = { loadCube: loadCube, loadCubeDir: loadCubeDir };
