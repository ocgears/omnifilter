#!/usr/bin/env node
'use strict';

// Checks which filters work on this machine's OpenCL device (or WebGPU's,
// with OMNIFILTER_BACKEND=webgpu): runs every
// filter, plus a few edge cases, and reports each as ok, failed or crashed.
// A driver bug can crash the whole process, so the cases run in a child
// process; if it crashes, the case it was on is marked crashed and a fresh
// child carries on with the rest.
//
//   npm run check-device               every case
//   npm run check-device -- blur swirl only these
//   OMNIFILTER_DEVICE=cpu npm run check-device

const { spawnSync } = require('child_process');

const W = 96;
const H = 64;

function testImage(width, height) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i % 4 === 3) ? 255 : (i * 2654435761) >>> 24;
  return data;
}

// Every case, by name. Filters run at a small size with default settings.
function allCases(gpu) {
  const cases = {};
  for (const f of gpu.list()) {
    if (f.group === 'Neural style') continue; // ONNX Runtime, not kernels
    cases[f.name] = () => gpu.apply(f.name, testImage(W, H), W, H, {});
  }
  // A texture wider than the device allows, so the filter runs scaled down.
  cases['wide texture'] = () => {
    const width = (gpu.deviceInfo().image2dMaxWidth || 8192) + 8;
    return gpu.apply('swirl', testImage(width, 3), width, 3, {});
  };
  // Tall enough for several adaptive bands.
  cases['tall banded image'] = () => gpu.apply('median', testImage(23, 700), 23, 700, {});
  return cases;
}

// Child: runs the named cases in order, reporting each as a JSON line, so the
// parent knows which case was running if this process dies.
async function child(names) {
  const say = (message) => process.stdout.write(JSON.stringify(message) + '\n');
  const gpu = require('../server/lib/gpu_filters');
  let cases;
  try {
    await gpu.ready();
    const device = gpu.deviceInfo();
    say({ device: device.name + ' (' + device.platform + ', ' + device.version.trim() + ')' });
    cases = allCases(gpu);
  } catch (e) {
    say({ fatal: e.message });
    return;
  }
  for (const name of names) {
    say({ start: name });
    try {
      if (!cases[name]) throw new Error('no such case');
      await cases[name]();
      say({ done: name, ok: true });
    } catch (e) {
      say({ done: name, ok: false, error: e.message.split('\n')[0] });
    }
  }
}

function runChild(names) {
  const result = spawnSync(process.execPath, [__filename, '--child'].concat(names),
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 20 * 60 * 1000 });
  const messages = (result.stdout || '').split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch (e) {
      return {};
    }
  });
  return { messages: messages, result: result };
}

function parent(only) {
  let names = only.length ? only : null;
  const results = []; // [name, status, detail]
  let device = null;
  for (;;) {
    if (!names) {
      // Ask a child for the case list (it needs the device to build it).
      const listed = spawnSync(process.execPath, [__filename, '--list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
      names = listed.status === 0 ? JSON.parse(listed.stdout) : [];
      if (!names.length) {
        console.error('Could not list the cases; is there an OpenCL device? Try `npm run devices`.');
        process.exit(1);
      }
    }
    const { messages, result } = runChild(names);
    let running = null;
    let sawDevice = false;
    let finished = 0;
    for (const m of messages) {
      if (m.device) {
        device = m.device;
        sawDevice = true;
      }
      if (m.fatal) {
        console.error('Could not use the OpenCL device: ' + m.fatal);
        process.exit(1);
      }
      if (m.start) running = m.start;
      if (m.done) {
        results.push([m.done, m.ok ? 'ok' : 'FAILED', m.error || '']);
        running = null;
        finished++;
      }
    }
    const timedOut = result.error && result.error.code === 'ETIMEDOUT';
    const how = result.signal || (timedOut ? 'timed out' : 'exit code ' + result.status);
    if (!running) {
      // The child died outside any case: while setting up the device (e.g.
      // the driver crashed compiling the kernels), or between cases. Either
      // way the remaining cases never ran, so this isn't a pass.
      const clean = result.status === 0 && !result.signal && !result.error;
      if (!sawDevice || (!clean && finished < names.length)) {
        if (results.length) report(device, results);
        console.error('The check crashed ' + (sawDevice ? 'between cases' : 'while setting up the OpenCL device') +
          ' (' + how + '); try `npm run devices`, or another OMNIFILTER_DEVICE.');
        process.exit(1);
      }
      break;
    }
    results.push([running, timedOut ? 'TIMED OUT' : 'CRASHED', how]);
    names = names.slice(names.indexOf(running) + 1);
    if (!names.length) break;
  }

  const bad = report(device, results);
  process.exit(bad ? 1 : 0);
}

// Prints the results so far; returns how many weren't ok.
function report(device, results) {
  console.log('Device: ' + device);
  for (const [name, status, detail] of results) {
    console.log('  ' + status.padEnd(9) + ' ' + name + (detail ? ': ' + detail : ''));
  }
  const count = (status) => results.filter((r) => r[1] === status).length;
  const bad = results.length - count('ok');
  console.log(count('ok') + ' ok, ' + count('FAILED') + ' failed, ' + count('CRASHED') + ' crashed' +
    (count('TIMED OUT') ? ', ' + count('TIMED OUT') + ' timed out' : ''));
  return bad;
}

const args = process.argv.slice(2);
if (args[0] === '--child') {
  child(args.slice(1)).then(() => process.exit(0));
} else if (args[0] === '--list') {
  const gpu = require('../server/lib/gpu_filters');
  process.stdout.write(JSON.stringify(Object.keys(allCases(gpu))));
} else {
  parent(args);
}
