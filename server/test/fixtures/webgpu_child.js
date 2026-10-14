'use strict';

// Runs filters and stacks with the WebGPU backend, for webgpu_test.js, which
// runs the same ones with OpenCL in its own process (a process has one
// backend). Reads the cases as JSON from the file named first on the command
// line and writes { device, results } as JSON to the second, each result's
// pixels in base64.
process.env.OMNIFILTER_BACKEND = 'webgpu';
const fs = require('fs');
const gpuFilters = require('../../lib/gpu_filters');
const stack = require('../../lib/stack');

(async () => {
  const cases = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  await gpuFilters.ready();
  const results = [];
  for (const c of cases) {
    const rgba = Buffer.from(c.rgba, 'base64');
    try {
      const out = c.stack ?
        await stack.applyStack(stack.normalizeStack(c.stack), rgba, c.width, c.height) :
        await gpuFilters.apply(c.name, rgba, c.width, c.height, c.params);
      results.push({ pixels: Buffer.from(out).toString('base64') });
    } catch (e) {
      results.push({ error: e.message });
    }
  }
  fs.writeFileSync(process.argv[3], JSON.stringify({ device: gpuFilters.deviceInfo(), results: results }));
  process.exit(0);
})().catch((e) => {
  fs.writeFileSync(process.argv[3], JSON.stringify({ error: e.message }));
  process.exit(0);
});
