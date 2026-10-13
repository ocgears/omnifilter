#!/usr/bin/env node
'use strict';

// Lists the OpenCL devices on this machine and which one the filters would
// use, to help choose OMNIFILTER_DEVICE.

const gpuFilters = require('../server/lib/gpu_filters');

const mb = (bytes) => Math.round(bytes / (1024 * 1024)) + ' MB';

const devices = gpuFilters.devices();
if (!devices.length) {
  console.log('No OpenCL devices found. Is an OpenCL driver installed?');
  process.exit(1);
}

var chosen = null;
try {
  chosen = gpuFilters.deviceInfo();
} catch (e) {
  console.log(e.message + '\n');
}

for (const d of devices) {
  const mark = chosen && chosen.index === d.index ? '*' : ' ';
  console.log(mark + ' ' + d.index + ': ' + d.name + ' (' + d.type + ', ' + d.platform + ')');
  console.log('     ' + d.version.trim() + ', driver ' + d.driverVersion + ', ' + d.computeUnits +
    ' compute units, ' + mb(d.globalMemBytes) + ' memory, largest buffer ' + mb(d.maxAllocBytes));
  console.log('     work-groups up to ' + d.maxWorkGroupSize + ' (' + d.maxWorkItemSizes.join(' x ') + '), ' +
    (d.imageSupport ? 'images up to ' + d.image2dMaxWidth + ' x ' + d.image2dMaxHeight : 'no image support') +
    (d.unifiedMemory === false ? ', discrete' : ''));
}
if (chosen) {
  for (const failure of chosen.skipped) console.log('\nSkipped ' + failure);
  console.log('\n* is the device the filters use (OMNIFILTER_DEVICE=' + (process.env.OMNIFILTER_DEVICE || 'auto') + ').');
}
console.log('Set OMNIFILTER_DEVICE to auto, gpu, cpu, accelerator, a number above, or part of a device name.');
