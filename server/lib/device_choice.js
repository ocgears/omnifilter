'use strict';

// Choosing an OpenCL device, and fitting filters to its limits. These are
// plain functions over the device descriptions the addon's devices() returns
// (see DescribeDevice in native/omnifilter.cpp), so they can be tested with
// made-up devices.

// Share of a device's memory a single filter may plan to use. Drivers keep
// some for themselves, and integrated GPUs share it with everything else.
const MEMORY_SHARE = 0.9;

const TYPE_ORDER = { gpu: 0, accelerator: 1, other: 2, cpu: 3 };

// Best first: GPUs before other devices, discrete GPUs (with their own
// memory) before integrated ones, then more memory, then the driver's order.
function compareDevices(a, b) {
  return (TYPE_ORDER[a.type] - TYPE_ORDER[b.type]) ||
    ((a.unifiedMemory === false ? 0 : 1) - (b.unifiedMemory === false ? 0 : 1)) ||
    (b.globalMemBytes - a.globalMemBytes) ||
    (a.index - b.index);
}

// The devices to try, best first, for an OMNIFILTER_DEVICE setting:
//   auto (default)  the best GPU, or failing that any other device
//   any             the same
//   gpu, cpu,       only devices of that type
//   accelerator
//   2               the device with that index (`npm run devices` lists them),
//                   if there is one; otherwise a number is matched against
//                   names like anything else, so "6100" finds an Iris 6100
//   anything else   devices whose name, vendor, version or platform
//                   contains it, ignoring case, e.g. "RTX" or "pocl" (pocl's
//                   platform is "Portable Computing Language"; "PoCL" is in
//                   its version and platform vendor)
function candidates(devices, setting) {
  const usable = devices.filter((d) => d.available !== false && d.compilerAvailable !== false);
  const s = String(setting || 'auto').trim().toLowerCase();
  var picked;
  if (s === 'auto' || s === 'any') {
    picked = usable;
  } else if (s === 'gpu' || s === 'cpu' || s === 'accelerator') {
    picked = usable.filter((d) => d.type === s);
  } else if (/^\d+$/.test(s) && devices.some((d) => d.index === Number(s))) {
    picked = usable.filter((d) => d.index === Number(s));
  } else {
    picked = usable.filter((d) => [d.platform, d.platformVendor, d.name, d.vendor, d.version]
      .join(' ').toLowerCase().includes(s));
  }
  return picked.slice().sort(compareDevices);
}

// What a plan (from Plan.native()) needs from the device for a width x height
// image: its largest buffer, its total memory, whether it reads images
// (textures) and the largest 2D image.
function planNeeds(plan, width, height) {
  const sizes = [width * height * 4].concat(plan.buffers.map((b) => b.bytes));
  const images = new Map();
  const largestImage = [0, 0];
  for (const pass of plan.passes) {
    for (const arg of pass.args) {
      if (arg.img !== undefined) {
        const w = arg.width || width;
        const h = arg.height || height;
        largestImage[0] = Math.max(largestImage[0], w);
        largestImage[1] = Math.max(largestImage[1], h);
        images.set(arg.img + '/' + w + 'x' + h + arg.format, w * h * (arg.format === 'rgba32f' ? 16 : 4));
      } else if (arg.img3d !== undefined) {
        images.set(arg.img3d + '/3d' + arg.size, Math.pow(arg.size, 3) * 16);
      }
    }
  }
  const sum = (list) => list.reduce((a, b) => a + b, 0);
  return {
    largestBuffer: Math.max.apply(null, sizes),
    totalBytes: sum(sizes) + sum(Array.from(images.values())),
    usesImages: images.size > 0,
    largestImage: largestImage
  };
}

// How much to scale the image down by so the plan fits the device: 1 if it
// fits as it is, 0 if it can't run on this device at any size.
function fitScale(needs, device) {
  if (needs.usesImages && !device.imageSupport) return 0;
  var scale = 1;
  // Buffers grow with the pixel count, so with the square of the scale.
  if (needs.largestBuffer > device.maxAllocBytes) {
    scale = Math.min(scale, Math.sqrt(device.maxAllocBytes / needs.largestBuffer));
  }
  const budget = device.globalMemBytes * MEMORY_SHARE;
  if (needs.totalBytes > budget) scale = Math.min(scale, Math.sqrt(budget / needs.totalBytes));
  if (needs.usesImages) {
    scale = Math.min(scale, device.image2dMaxWidth / needs.largestImage[0] || 1,
      device.image2dMaxHeight / needs.largestImage[1] || 1);
  }
  return scale;
}

// OpenCL compiler options for a device: workarounds for known driver bugs
// (see common.cl), plus any extra options given in OMNIFILTER_CL_OPTIONS.
function buildOptions(device, extra) {
  const options = [];
  if (device.platform === 'rusticl') options.push('-D OMNIFILTER_TRIG_VIA_SINPI');
  if (extra) options.push(extra);
  return options.join(' ');
}

// Why a filter can't run on this device at all, or null if it can.
function unsupportedReason(needs, device) {
  if (needs.usesImages && !device.imageSupport) {
    return 'needs image (texture) support, which ' + device.name + ' does not have';
  }
  return null;
}

module.exports = {
  candidates: candidates,
  buildOptions: buildOptions,
  planNeeds: planNeeds,
  fitScale: fitScale,
  unsupportedReason: unsupportedReason
};
