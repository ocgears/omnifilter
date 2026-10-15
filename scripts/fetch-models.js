#!/usr/bin/env node
'use strict';

// Downloads the neural style transfer models (about 6.7 MB each) into
// models/, verifying each file's SHA-256. Run with `npm run fetch-models`.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { STYLES, MODEL_DIR } = require('../server/lib/filters/neural_models');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// The model host sometimes answers with a 5xx error or drops the connection,
// so try a few times, waiting longer each time.
async function download(style, attempts) {
  attempts = attempts || 4;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(style.url, { signal: AbortSignal.timeout(120000) });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      const error = new Error(style.file + ': HTTP ' + res.status);
      if (res.status < 500 && res.status !== 429) throw Object.assign(error, { final: true });
      throw error;
    } catch (err) {
      if (err.final || attempt >= attempts) throw err;
      const wait = 2000 * Math.pow(2, attempt - 1);
      console.log(style.file + ': ' + err.message.replace(style.file + ': ', '') + ', retrying in ' + wait / 1000 + 's');
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

async function fetchModel(style) {
  const target = path.join(MODEL_DIR, style.file);
  if (fs.existsSync(target) && sha256(fs.readFileSync(target)) === style.sha256) {
    console.log('ok       ' + style.file);
    return;
  }
  const bytes = await download(style);
  if (sha256(bytes) !== style.sha256) throw new Error(style.file + ': checksum mismatch, not saved');
  fs.writeFileSync(target + '.tmp', bytes);
  fs.renameSync(target + '.tmp', target);
  console.log('fetched  ' + style.file + ' (' + (bytes.length / 1e6).toFixed(1) + ' MB)');
}

(async () => {
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  for (const style of STYLES) await fetchModel(style);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
