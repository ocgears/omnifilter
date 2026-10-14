// Choosing a device and fitting filters to its limits: the pure logic with
// made-up devices, then the same paths on the real device.
const expect = require('chai').expect;
const gpu = require(__dirname + '/../lib/gpu_filters');
const choice = require(__dirname + '/../lib/device_choice');
const { Plan, buf, int } = require(__dirname + '/../lib/filters/plan');
const ref = require(__dirname + '/reference');

const GB = 1024 * 1024 * 1024;

function fakeDevice(overrides) {
  return Object.assign({
    platform: 'Test', name: 'Device', type: 'gpu', available: true, compilerAvailable: true,
    unifiedMemory: true, globalMemBytes: 2 * GB, maxAllocBytes: GB / 2,
    imageSupport: true, image2dMaxWidth: 16384, image2dMaxHeight: 16384
  }, overrides);
}

describe('choosing a device', () => {
  const devices = [
    fakeDevice({ index: 0, platform: 'Apple', name: 'Intel Core i5 CPU', type: 'cpu', globalMemBytes: 16 * GB }),
    fakeDevice({ index: 1, platform: 'Apple', name: 'Intel Iris Graphics', globalMemBytes: 1.5 * GB }),
    fakeDevice({ index: 2, platform: 'Apple', name: 'AMD Radeon Pro 560X', unifiedMemory: false, globalMemBytes: 4 * GB }),
    fakeDevice({ index: 3, platform: 'Portable Computing Language', platformVendor: 'The pocl project',
      name: 'cpu-haswell-AMD EPYC 7763', vendor: 'AuthenticAMD', version: 'OpenCL 3.0 PoCL 5.0+debian', type: 'cpu' }),
    fakeDevice({ index: 4, platform: 'rusticl', name: 'llvmpipe (LLVM 17.0.6, 256 bits)', type: 'cpu', available: false })
  ];
  const indexes = (setting) => choice.candidates(devices, setting).map((d) => d.index);

  it('prefers a discrete GPU, then an integrated one, then the CPU', () => {
    expect(indexes()).to.eql([2, 1, 0, 3]);
    expect(indexes('auto')).to.eql([2, 1, 0, 3]);
    expect(indexes('any')).to.eql([2, 1, 0, 3]);
  });

  it('filters by type', () => {
    expect(indexes('gpu')).to.eql([2, 1]);
    expect(indexes('CPU')).to.eql([0, 3]);
  });

  it('picks a device by index or by part of its name', () => {
    expect(indexes('1')).to.eql([1]);
    expect(indexes('radeon')).to.eql([2]);
    expect(indexes('apple')).to.eql([2, 1, 0]);
    expect(indexes('nvidia')).to.eql([]);
  });

  it('finds pocl by its version and vendor, not just its platform name', () => {
    expect(indexes('pocl')).to.eql([3]);
    expect(indexes('portable computing')).to.eql([3]);
  });

  it('works around known driver bugs only where needed', () => {
    const rusticl = fakeDevice({ platform: 'rusticl', name: 'llvmpipe' });
    expect(choice.buildOptions(rusticl)).to.equal('-D OMNIFILTER_TRIG_VIA_SINPI');
    expect(choice.buildOptions(devices[1])).to.equal('');
    expect(choice.buildOptions(devices[1], '-cl-opt-disable')).to.equal('-cl-opt-disable');
  });

  it('skips devices that are unavailable or have no compiler', () => {
    expect(indexes('rusticl')).to.eql([]);
    expect(indexes('4')).to.eql([]);
  });
});

describe('fitting filters to a device', () => {
  const blur = gpu.plan('blur', 400, 300, {});
  const swirl = gpu.plan('swirl', 400, 300, {});

  it('measures what a plan needs', () => {
    const needs = choice.planNeeds(blur, 400, 300);
    expect(needs.largestBuffer).to.equal(400 * 300 * 4);
    expect(needs.totalBytes).to.be.at.least(3 * 400 * 300 * 4);
    expect(needs.usesImages).to.equal(false);
    const textured = choice.planNeeds(swirl, 400, 300);
    expect(textured.usesImages).to.equal(true);
    expect(textured.largestImage).to.eql([400, 300]);
  });

  it('runs at full size when the plan fits', () => {
    expect(choice.fitScale(choice.planNeeds(blur, 400, 300), fakeDevice())).to.equal(1);
  });

  it('scales down so the largest buffer fits a small allocation limit', () => {
    const device = fakeDevice({ maxAllocBytes: 100 * 1000 });
    const scale = choice.fitScale(choice.planNeeds(blur, 400, 300), device);
    expect(scale).to.be.below(1);
    const w = Math.floor(400 * scale);
    const h = Math.floor(300 * scale);
    expect(choice.fitScale(choice.planNeeds(gpu.plan('blur', w, h, {}), w, h), device)).to.equal(1);
  });

  it('scales down so the total fits the device memory', () => {
    const device = fakeDevice({ globalMemBytes: 400 * 1000 });
    expect(choice.fitScale(choice.planNeeds(blur, 400, 300), device)).to.be.below(1);
  });

  it('scales textures down to the largest image the device allows', () => {
    const device = fakeDevice({ image2dMaxWidth: 200, image2dMaxHeight: 200 });
    expect(choice.fitScale(choice.planNeeds(swirl, 400, 300), device)).to.equal(0.5);
    // Filters without textures don't care.
    expect(choice.fitScale(choice.planNeeds(blur, 400, 300), device)).to.equal(1);
  });

  it('reports texture filters as unsupported on a device without images', () => {
    const device = fakeDevice({ name: 'No Images', imageSupport: false });
    const needs = choice.planNeeds(swirl, 400, 300);
    expect(choice.fitScale(needs, device)).to.equal(0);
    expect(choice.unsupportedReason(needs, device)).to.include('No Images');
    expect(choice.unsupportedReason(choice.planNeeds(blur, 400, 300), device)).to.equal(null);
  });
});

describe('the real device', function() {
  this.timeout(30000);

  // With the WebGPU backend, setting up the device is asynchronous.
  before(() => gpu.ready());

  it('is listed, chosen and described', () => {
    const devices = gpu.devices();
    expect(devices.length).to.be.at.least(1);
    const info = gpu.deviceInfo();
    const listed = devices.find((d) => d.index === info.index);
    expect(listed.name).to.equal(info.name);
    for (const field of ['type', 'version', 'maxAllocBytes', 'globalMemBytes', 'maxWorkGroupSize', 'maxWorkItemSizes']) {
      expect(info, field).to.have.property(field);
    }
    expect(info.skipped).to.be.an('array');
  });

  it('runs a texture filter on an image wider than the device allows', function() {
    const info = gpu.deviceInfo();
    if (!info.imageSupport) this.skip();
    const width = info.image2dMaxWidth + 8;
    const height = 4;
    return gpu.apply('swirl', ref.randomImage(width, height, 5), width, height, {})
      .then((out) => expect(out.length).to.equal(width * height * 4));
  });

  it('shrinks a work-group request that is too large for the device', () => {
    // 32x32 RGBA is 4096 bytes, the same as the histogram's 1024 counters,
    // so the histogram buffer can be the plan's output.
    const size = 32;
    const src = ref.randomImage(size, size, 9);
    const plan = new Plan(size, size);
    const hist = plan.buffer(4096, { zero: true });
    // Far more work-items per group than any device allows, in 2 groups.
    plan.pass('histogram', [buf('src'), buf(hist), int(size * size)], { global: [2 * 65536], local: [65536] });
    plan.current = hist;
    return gpu.runPlan(src, size, size, plan).then((out) => {
      const counts = new Int32Array(out.buffer, out.byteOffset, 1024);
      const expected = new Int32Array(1024);
      for (let p = 0; p < size * size; p++) {
        if (!src[p * 4 + 3]) continue;  // transparent pixels aren't counted
        expected[src[p * 4]]++;
        expected[256 + src[p * 4 + 1]]++;
        expected[512 + src[p * 4 + 2]]++;
      }
      expect(Array.from(counts.slice(0, 768))).to.eql(Array.from(expected.slice(0, 768)));
    });
  });
});
