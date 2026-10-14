#!/usr/bin/env node
'use strict';

// Lists the OpenCL devices on this machine and which one the filters would
// use, to help choose OMNIFILTER_DEVICE. With OMNIFILTER_BACKEND=webgpu,
// describes the WebGPU adapter the filters would use.

const gpuFilters = require('../server/lib/gpu_filters');

const mb = (bytes) => Math.round(bytes / (1024 * 1024)) + ' MB';

async function main() {
  var chosen = null;
  try {
    await gpuFilters.ready();
    chosen = gpuFilters.deviceInfo();
  } catch (e) {
    console.log(e.message + '\n');
  }

  const devices = gpuFilters.devices();
  if (!devices.length) {
    console.log('No ' + gpuFilters.backendLabel + ' devices found. ' +
      (gpuFilters.backend === 'webgpu' ? '' : 'Is an OpenCL driver installed?'));
    process.exit(1);
  }

  for (const d of devices) {
    const mark = chosen && chosen.index === d.index ? '*' : ' ';
    console.log(mark + ' ' + d.index + ': ' + d.name + ' (' + d.type + ', ' + d.platform + ')');
    console.log('     ' + d.version.trim() + (d.driverVersion ? ', driver ' + d.driverVersion : '') +
      (d.computeUnits ? ', ' + d.computeUnits + ' compute units' : '') + ', ' +
      mb(d.globalMemBytes) + ' memory, largest buffer ' + mb(d.maxAllocBytes));
    console.log('     work-groups up to ' + d.maxWorkGroupSize + ' (' + d.maxWorkItemSizes.join(' x ') + '), ' +
      (d.imageSupport ? 'images up to ' + d.image2dMaxWidth + ' x ' + d.image2dMaxHeight : 'no image support') +
      (d.unifiedMemory === false ? ', discrete' : ''));
  }
  if (chosen) {
    for (const failure of chosen.skipped) console.log('\nSkipped ' + failure);
    console.log('\n* is the device the filters use (OMNIFILTER_DEVICE=' + (process.env.OMNIFILTER_DEVICE || 'auto') + ').');
  }
  console.log(gpuFilters.backend === 'webgpu' ?
    'Set OMNIFILTER_DEVICE to auto, gpu, low-power or cpu.' :
    'Set OMNIFILTER_DEVICE to auto, gpu, cpu, accelerator, a number above, or part of a device name.');
  process.exit(0);
}

main();
