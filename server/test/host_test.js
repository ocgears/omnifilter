// The host side of running filters, with a stand-in for the native addon:
// queueing runs for the device, remembering a failed start-up, reporting
// filters a device can't run, choosing a device, and the install and
// check-device scripts.
const expect = require('chai').expect;
const Module = require('module');
const path = require('path');
const { spawnSync } = require('child_process');
const choice = require(__dirname + '/../lib/device_choice');
const install = require(__dirname + '/../../scripts/install-native');
const { Plan, img, buf } = require(__dirname + '/../lib/filters/plan');

const GB = 1024 * 1024 * 1024;
const NATIVE = require.resolve(__dirname + '/../lib/native');
const GPU = require.resolve(__dirname + '/../lib/gpu_filters');

function fakeDevice(overrides) {
  return Object.assign({
    index: 0, platform: 'Test', platformVendor: 'Test', name: 'Fake GPU', vendor: 'Test',
    version: 'OpenCL 1.2', type: 'gpu', available: true, compilerAvailable: true, unifiedMemory: true,
    globalMemBytes: 2 * GB, maxAllocBytes: GB / 2, imageSupport: true, image2dMaxWidth: 16384, image2dMaxHeight: 16384
  }, overrides);
}

// A stand-in for the addon, counting calls. filter() echoes its input.
function fakeNative(device, overrides) {
  const calls = { devices: 0, init: 0, filter: 0 };
  return Object.assign({
    calls: calls,
    devices: () => {
      calls.devices++;
      return [device];
    },
    init: () => {
      calls.init++;
    },
    deviceInfo: () => Object.assign({}, device),
    kernels: () => [],
    filter: (rgba) => {
      calls.filter++;
      return Promise.resolve(Buffer.from(rgba));
    }
  }, overrides);
}

// A fresh gpu_filters (with its own device state and queue) over `native`.
// The modules other suites loaded are put back afterwards.
function loadGpu(native) {
  const saved = { native: require.cache[NATIVE], gpu: require.cache[GPU] };
  const fake = new Module(NATIVE);
  fake.filename = NATIVE;
  fake.exports = native;
  fake.loaded = true;
  require.cache[NATIVE] = fake;
  delete require.cache[GPU];
  try {
    return require(GPU);
  } finally {
    require.cache[NATIVE] = saved.native;
    if (saved.gpu) require.cache[GPU] = saved.gpu;
    else delete require.cache[GPU];
  }
}

const image = (w, h) => Buffer.alloc(w * h * 4, 128);

// The fake devices are GPUs, so a device setting from the environment (such
// as OMNIFILTER_DEVICE=cpu for a CPU test run) is set aside while they run.
// These tests use the OpenCL host code with a stand-in addon, whatever device
// or backend the rest of the tests run on.
function ignoreDeviceSetting() {
  const saved = {};
  const names = ['OMNIFILTER_DEVICE', 'OMNIFILTER_BACKEND'];
  before(() => {
    for (const name of names) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });
  after(() => {
    for (const name of names) if (saved[name] !== undefined) process.env[name] = saved[name];
  });
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the device queue', () => {
  ignoreDeviceSetting();

  it('runs one native filter at a time, whichever way it is called', () => {
    var active = 0;
    var most = 0;
    var started = 0;
    const native = fakeNative(fakeDevice({ maxAllocBytes: 20000 }), {
      filter: (rgba) => {
        started++;
        active++;
        most = Math.max(most, active);
        return delay(5).then(() => {
          active--;
          return Buffer.from(rgba);
        });
      }
    });
    const gpu = loadGpu(native);
    const runs = [
      gpu.apply('gamma', image(32, 32), 32, 32, {}),
      gpu.apply('gamma', image(128, 128), 128, 128, {}), // too big for maxAllocBytes: runs scaled down
      gpu.runPlan(image(16, 16), 16, 16, new Plan(16, 16)),
      gpu.apply('threshold', image(8, 8), 8, 8, {}),
      gpu.runPlan(image(16, 16), 16, 16, new Plan(16, 16))
    ];
    return Promise.all(runs).then((outputs) => {
      expect(started).to.equal(5);
      expect(most).to.equal(1);
      expect(outputs[1].length).to.equal(128 * 128 * 4);
    });
  });

  it('moves on to the next run when one fails', () => {
    var active = 0;
    var most = 0;
    var n = 0;
    const native = fakeNative(fakeDevice(), {
      filter: (rgba) => {
        const mine = n++;
        active++;
        most = Math.max(most, active);
        if (mine === 1) {
          active--;
          throw new Error('driver says no'); // thrown, not rejected, as the addon's argument checks do
        }
        return delay(2).then(() => {
          active--;
          if (mine === 2) throw new Error('device lost');
          return Buffer.from(rgba);
        });
      }
    });
    const gpu = loadGpu(native);
    const settle = (p) => p.then(() => 'ok', (e) => e.message);
    return Promise.all([0, 1, 2, 3].map(() => settle(gpu.apply('gamma', image(4, 4), 4, 4, {}))))
      .then((results) => {
        expect(results).to.eql(['ok', 'driver says no', 'device lost', 'ok']);
        expect(most).to.equal(1);
      });
  });
});

describe('starting the device', () => {
  ignoreDeviceSetting();

  it('remembers that every device failed, for a while', () => {
    const native = fakeNative(fakeDevice(), {
      init: () => {
        native.calls.init++;
        throw new Error('kernels failed to compile');
      }
    });
    const gpu = loadGpu(native);
    const realNow = Date.now;
    return gpu.apply('gamma', image(4, 4), 4, 4, {}).then(() => {
      throw new Error('should have failed');
    }, (e) => {
      expect(e.code).to.equal('NO_DEVICE');
      expect(e.message).to.include('kernels failed to compile');
      expect(native.calls).to.include({ devices: 1, init: 1 });
      expect(() => gpu.deviceInfo()).to.throw(/kernels failed to compile/);
      expect(gpu.list().length).to.be.above(0);
      return gpu.runPlan(image(4, 4), 4, 4, new Plan(4, 4)).catch((e2) => e2);
    }).then((e) => {
      expect(e.code).to.equal('NO_DEVICE');
      expect(native.calls).to.include({ devices: 1, init: 1, filter: 0 });
      // Some minutes later it tries again.
      const later = realNow() + 6 * 60 * 1000;
      Date.now = () => later;
      expect(() => gpu.deviceInfo()).to.throw(/kernels failed to compile/);
      expect(native.calls).to.include({ devices: 2, init: 2 });
    }).finally(() => {
      Date.now = realNow;
    });
  });
});

describe('filters a device cannot run', () => {
  ignoreDeviceSetting();

  const noImages = fakeDevice({ imageSupport: false, image2dMaxWidth: undefined, image2dMaxHeight: undefined });
  const expectUnsupported = (promise, pattern) => promise.then(() => {
    throw new Error('should have failed');
  }, (e) => {
    expect(e.code).to.equal('UNSUPPORTED');
    expect(e.status).to.equal(400);
    expect(e.message).to.match(pattern);
  });

  it('rejects a filter that needs textures with a 400 error', () => {
    const native = fakeNative(noImages);
    const gpu = loadGpu(native);
    expect(gpu.list().find((f) => f.name === 'swirl').available).to.equal(false);
    return expectUnsupported(gpu.apply('swirl', image(8, 8), 8, 8, {}), /Swirl needs image \(texture\) support/)
      .then(() => expect(native.calls.filter).to.equal(0));
  });

  it('checks a hand-built plan against the device too', () => {
    const native = fakeNative(fakeDevice({ maxAllocBytes: 1000, imageSupport: false }));
    const gpu = loadGpu(native);
    const sampling = new Plan(8, 8);
    const out = sampling.rgba();
    sampling.pass('swirl', [img('src'), buf(out)]);
    return expectUnsupported(gpu.runPlan(image(8, 8), 8, 8, sampling), /texture/)
      .then(() => expectUnsupported(gpu.runPlan(image(64, 64), 64, 64, new Plan(64, 64)), /64x64 image is too large/))
      .then(() => gpu.runPlan(image(8, 8), 8, 8, new Plan(8, 8)))
      .then((out) => {
        expect(out.length).to.equal(8 * 8 * 4);
        expect(native.calls.filter).to.equal(1);
      });
  });
});

describe('choosing a device by a setting', () => {
  const devices = [
    fakeDevice({ index: 0, platform: 'Apple', name: 'Intel(R) Core(TM) i5-5257U CPU', type: 'cpu' }),
    fakeDevice({ index: 1, platform: 'Apple', name: 'Intel(R) Iris(TM) Graphics 6100' }),
    fakeDevice({ index: 2, platform: 'NVIDIA CUDA', name: 'NVIDIA GeForce RTX 3060', unifiedMemory: false }),
    fakeDevice({ index: 3, platform: 'Intel FPGA SDK', name: 'FPGA Emulation Device', type: 'accelerator' })
  ];
  const indexes = (setting) => choice.candidates(devices, setting).map((d) => d.index);

  it('treats a number as an index only if there is such a device', () => {
    expect(indexes('1')).to.eql([1]);
    expect(indexes('6100')).to.eql([1]);
    expect(indexes('3060')).to.eql([2]);
    expect(indexes('9')).to.eql([]);
  });

  it('picks accelerators by type', () => {
    expect(indexes('accelerator')).to.eql([3]);
    expect(indexes('Accelerator')).to.eql([3]);
  });
});

describe('the install script', () => {
  it('only compiles when OMNIFILTER_BUILD_FROM_SOURCE says yes', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', ' Yes ']) expect(install.wantsSourceBuild(value)).to.equal(true);
    for (const value of [undefined, '', '0', 'false', 'no', 'off']) expect(install.wantsSourceBuild(value)).to.equal(false);
  });

  it('blames a missing OpenCL runtime only when the error names it', () => {
    const file = '/home/me/opencl-work/omnifilter/prebuilds/linux-x64/omnifilter.node';
    expect(install.missingOpenCL('libOpenCL.so.1: cannot open shared object file: No such file or directory',
      { file: file, platform: 'linux' })).to.equal(true);
    expect(install.missingOpenCL(file + ': undefined symbol: _ZN4Napi5Error3NewEP10napi_env__',
      { file: file, platform: 'linux' })).to.equal(false);
    expect(install.missingOpenCL(file + ': version `GLIBCXX_3.4.32\' not found', { file: file, platform: 'linux' }))
      .to.equal(false);
    const mac = '/Users/me/OpenCL/omnifilter/prebuilds/darwin-x64/omnifilter.node';
    expect(install.missingOpenCL('dlopen(' + mac + ', 0x0001): Library not loaded: ' +
      '/System/Library/Frameworks/OpenCL.framework/Versions/A/OpenCL', { file: mac, platform: 'darwin' })).to.equal(true);
    expect(install.missingOpenCL('dlopen(' + mac + ', 0x0001): symbol not found in flat namespace',
      { file: mac, platform: 'darwin' })).to.equal(false);
  });

  it('on Windows, blames OpenCL for a missing module only if OpenCL.dll is missing', () => {
    const file = 'C:\\opencl\\omnifilter\\prebuilds\\win32-x64\\omnifilter.node';
    const error = 'The specified module could not be found.\r\n\\\\?\\' + file;
    expect(install.missingOpenCL(error, { file: file, platform: 'win32', dllFound: () => false })).to.equal(true);
    expect(install.missingOpenCL(error, { file: file, platform: 'win32', dllFound: () => true })).to.equal(false);
  });
});

describe('check-device', () => {
  it('fails if the device crashes the check before any case runs', function() {
    this.timeout(60000);
    const script = path.join(__dirname, '..', '..', 'scripts', 'check-device.js');
    const crash = path.join(__dirname, 'fixtures', 'crash_child.js');
    const result = spawnSync(process.execPath, [script, 'gamma'], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { NODE_OPTIONS: '--require ' + crash })
    });
    expect(result.status).to.equal(1);
    expect(result.stderr).to.include('crashed while setting up the OpenCL device (SIGKILL)');
  });
});
