'use strict';

// Runs filter plans (the format server/lib/filters builds, and
// native/omnifilter.cpp runs with OpenCL) with WebGPU. It takes a GPU object
// (navigator.gpu in a browser, or Dawn's for Node) and nothing else from its
// surroundings, so the browser's live preview (client/src/gpu/engine.ts adds
// drawing and camera frames to it) and the server's WebGPU backend
// (backend.js) share it. Types for TypeScript are in engine.d.ts.
//
// Images are RGBA8 pixel buffers (straight alpha, row by row), not textures:
// kernels read them through the helpers kernel.js generates.

const { COMMON } = require('./common');
const { isWritable, makeKernel } = require('./kernel');
const KERNELS = require('./kernels');

// WebGPU's flag values, so this doesn't need the GPUBufferUsage globals
// (which Node doesn't have, and old browsers don't either).
const USAGE = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80 };
const MAP_READ = 0x1;
const COMPUTE_STAGE = 0x4;

const PIXELS = USAGE.STORAGE | USAGE.COPY_SRC | USAGE.COPY_DST;
// Each pass's scalar arguments get a slot this size in one uniform buffer
// (WebGPU's minimum uniform offset alignment).
const UNIFORM_SLOT = 256;

const align4 = (n) => Math.max(4, Math.ceil(n / 4) * 4);

// Copies bytes (any typed array) into a buffer. writeBuffer takes whole
// 4-byte words, so an odd length is padded.
function write(device, buffer, bytes) {
  var view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength % 4) {
    const padded = new Uint8Array(align4(view.byteLength));
    padded.set(view);
    view = padded;
  }
  device.queue.writeBuffer(buffer, 0, view.buffer, view.byteOffset, view.byteLength);
}

class GpuEngine {
  // options.bands: run banded passes (see Plan.band) in bands of rows, each
  // submitted on its own, as the OpenCL addon does, so one long dispatch on
  // a big image can't trip the OS's GPU watchdog. The browser's previews are
  // small enough not to need it.
  constructor(device, adapterInfo, options) {
    this.device = device;
    this.adapterInfo = adapterInfo;
    this.bands = Boolean(options && options.bands);
    this.kernels = new Map();
    this.pipelines = new Map();
    // Set when the device is lost (driver reset, a tab in the background too
    // long on some phones); the owner should make a new engine.
    this.lost = false;
    device.lost.then(() => {
      this.lost = true;
    });
    // The first error the GPU reported that no checked() call caught (work
    // the GPU refused, so its results are missing), until takeError().
    this.error = null;
    if (typeof device.addEventListener === 'function') {
      device.addEventListener('uncapturederror', (event) => {
        if (!this.error) this.error = event.error;
      });
    }
  }

  // Runs fn (which may return a promise) and throws a GpuError if the GPU
  // refused any of the work it asked for: out of memory, or a call outside
  // WebGPU's rules or the device's limits. The GPU skips such work without
  // a word otherwise, and the image comes out blank. err.outOfMemory says
  // which. Only for work nothing else is giving the same device meanwhile.
  async checked(fn) {
    const device = this.device;
    if (typeof device.pushErrorScope !== 'function') return fn();
    device.pushErrorScope('out-of-memory');
    device.pushErrorScope('validation');
    device.pushErrorScope('internal');
    var result;
    var thrown = null;
    try {
      result = await fn();
    } catch (e) {
      thrown = e;
    }
    const internal = await device.popErrorScope();
    const validation = await device.popErrorScope();
    const memory = await device.popErrorScope();
    if (thrown) throw thrown;
    const error = memory || validation || internal;
    if (error) {
      const err = new Error((memory ? 'The GPU ran out of memory' : 'The GPU refused the work') +
        ': ' + error.message);
      err.name = 'GpuError';
      err.outOfMemory = Boolean(memory);
      err.result = result;
      throw err;
    }
    return result;
  }

  // The error the GPU reported outside checked(), if any, and forgets it.
  takeError() {
    const error = this.error;
    this.error = null;
    return error;
  }

  // An engine on gpu's best adapter, or null if it has none. Asks for the
  // largest buffers the adapter allows. options: powerPreference
  // ('high-performance' by default), forceFallbackAdapter (a software
  // adapter), bands (see the constructor).
  static async fromGpu(gpu, options) {
    const opts = options || {};
    if (!gpu) return null;
    const adapter = await gpu.requestAdapter({
      powerPreference: opts.powerPreference || 'high-performance',
      forceFallbackAdapter: Boolean(opts.forceFallbackAdapter)
    });
    if (!adapter) return null;
    // The largest textures too: photos go onto the GPU as one, and phone
    // panoramas are wider than the default limit (8192).
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
        maxTextureDimension2D: adapter.limits.maxTextureDimension2D
      }
    });
    const info = adapter.info || {};
    return new this(device, {
      vendor: info.vendor || '',
      architecture: info.architecture || '',
      description: info.description || '',
      fallback: Boolean(info.isFallbackAdapter || adapter.isFallbackAdapter)
    }, opts);
  }

  // Whether there's a WGSL version of an OpenCL kernel.
  static hasKernel(name) {
    return Object.prototype.hasOwnProperty.call(KERNELS, name);
  }

  // Every kernel name there's a WGSL version of.
  static kernelNames() {
    return Object.keys(KERNELS);
  }

  // Why this engine can't run a plan (a kernel it doesn't have), or null if
  // it can.
  static unsupported(plan) {
    for (const pass of plan.passes) {
      if (!GpuEngine.hasKernel(pass.kernel)) return 'kernel ' + pass.kernel;
    }
    return null;
  }

  kernel(name) {
    var k = this.kernels.get(name);
    if (!k) {
      const spec = KERNELS[name];
      if (!spec) throw new Error('No WebGPU version of the ' + name + ' kernel');
      k = makeKernel(name, spec, COMMON);
      this.kernels.set(name, k);
    }
    return k;
  }

  // What a kernel's pipeline is made from: its bind group layout and the
  // pipeline's description.
  pipelineSpec(name) {
    const k = this.kernel(name);
    const entries = k.bindings.map((b, i) => ({
      binding: i,
      visibility: COMPUTE_STAGE,
      buffer: { type: isWritable(b.kind) ? 'storage' : 'read-only-storage' }
    }));
    entries.push({
      binding: k.bindings.length,
      visibility: COMPUTE_STAGE,
      buffer: { type: 'uniform' }
    });
    const layout = this.device.createBindGroupLayout({ entries: entries });
    const module = this.device.createShaderModule({ code: k.source, label: name });
    return {
      layout: layout,
      descriptor: {
        label: name,
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module: module, entryPoint: 'main' }
      }
    };
  }

  pipeline(name) {
    var p = this.pipelines.get(name);
    if (!p) {
      const spec = this.pipelineSpec(name);
      p = { pipeline: this.device.createComputePipeline(spec.descriptor), layout: spec.layout };
      this.pipelines.set(name, p);
    }
    return p;
  }

  // Compiles kernels' pipelines in the background (createComputePipeline-
  // Async), so the first use of a filter doesn't stall the page while the
  // GPU's compiler works; run() then finds them ready. Resolves once they
  // are. Kernels this engine doesn't have are left for run() to report.
  preparePipelines(names) {
    if (!this.compiling) this.compiling = new Map();
    const device = this.device;
    return Promise.all(Array.from(new Set(names)).map((name) => {
      if (this.pipelines.has(name) || !GpuEngine.hasKernel(name)) return null;
      if (!this.compiling.has(name)) {
        const spec = this.pipelineSpec(name);
        const made = typeof device.createComputePipelineAsync === 'function' ?
          device.createComputePipelineAsync(spec.descriptor) :
          Promise.resolve(device.createComputePipeline(spec.descriptor));
        this.compiling.set(name, made.then((pipeline) => {
          if (!this.pipelines.has(name)) this.pipelines.set(name, { pipeline: pipeline, layout: spec.layout });
        }, () => {
          // run() compiles it again, and reports what's wrong.
        }).finally(() => this.compiling.delete(name)));
      }
      return this.compiling.get(name);
    })).then(() => undefined);
  }

  // Whether every one of these kernels' pipelines is ready.
  hasPipelines(names) {
    return names.every((name) => this.pipelines.has(name) || !GpuEngine.hasKernel(name));
  }

  // Compiles kernels ahead of time (they compile on first use otherwise),
  // and reports WGSL errors with the kernel's name.
  async prepare(names) {
    for (const name of names) {
      const k = this.kernel(name);
      const module = this.device.createShaderModule({ code: k.source, label: name });
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((m) => m.type === 'error');
      if (errors.length) {
        throw new Error(name + ': ' +
          errors.map((e) => 'line ' + e.lineNum + ': ' + e.message).join('; '));
      }
      this.pipeline(name);
    }
  }

  // An image of width x height, filled from rgba (any typed array of the
  // bytes) if given.
  createImage(width, height, rgba) {
    const buffer = this.device.createBuffer({ size: align4(width * height * 4), usage: PIXELS });
    if (rgba) write(this.device, buffer, rgba);
    return { buffer: buffer, width: width, height: height };
  }

  release(image) {
    if (image) image.buffer.destroy();
  }

  // Runs a plan on src (which it leaves alone) and returns a new image with
  // the result; the caller releases it. extras are more input images, by the
  // buffer names the plan uses for them. The plan works on src's size, and
  // so does its output unless outputSize ({ width, height }) says otherwise.
  run(plan, src, extras, outputSize) {
    const device = this.device;
    const width = src.width;
    const height = src.height;
    const named = new Map([['src', src.buffer]]);
    for (const name of Object.keys(extras || {})) named.set(name, extras[name].buffer);
    const temporary = [];
    for (const b of plan.buffers) {
      const buffer = device.createBuffer({ size: align4(b.bytes), usage: PIXELS });
      if (b.init) write(device, buffer, b.init);
      named.set(b.name, buffer);
      if (b.name !== plan.output) temporary.push(buffer);
    }

    // Each dispatch: the pass, its global size, and row0 for a band.
    const dispatches = [];
    for (const pass of plan.passes) {
      const k = this.kernel(pass.kernel);
      if (pass.args.length !== k.args.length) {
        throw new Error(pass.kernel + ' takes ' + k.args.length + ' arguments, the plan gave ' +
          pass.args.length);
      }
      const global = pass.global || [width, height];
      const gx = global[0];
      const gy = global[1] || 1;
      const banded = this.bands && pass.band && KERNELS[pass.kernel].guard === 'band';
      if (!banded) {
        dispatches.push({ pass: pass, kernel: k, gx: gx, gy: gy, row0: null });
        continue;
      }
      for (var row0 = 0; row0 < gy; row0 += pass.band) {
        dispatches.push({ pass: pass, kernel: k, gx: gx, gy: Math.min(pass.band, gy - row0), row0: row0 });
      }
    }

    const slots = Math.max(1, dispatches.length);
    const uniforms = device.createBuffer({ size: slots * UNIFORM_SLOT, usage: USAGE.UNIFORM | USAGE.COPY_DST });
    temporary.push(uniforms);
    const uniformData = new ArrayBuffer(slots * UNIFORM_SLOT);
    const dataBuffers = new Map();

    const commands = dispatches.map((d, index) => {
      const pass = d.pass;
      const k = d.kernel;
      // Scalars, in declaration order, then the global size (8-aligned).
      const view = new DataView(uniformData, index * UNIFORM_SLOT, UNIFORM_SLOT);
      var offset = 0;
      const entries = [];
      pass.args.forEach((arg, n) => {
        const decl = k.args[n];
        if (decl.kind === 'i32' || decl.kind === 'f32') {
          var value = arg.int !== undefined ? arg.int : arg.float;
          // A band's row0 is the kernel's last argument.
          if (d.row0 !== null && n === pass.args.length - 1) value = d.row0;
          if (decl.kind === 'i32') view.setInt32(offset, Math.round(value), true);
          else view.setFloat32(offset, value, true);
          offset += 4;
          return;
        }
        var buffer;
        if (arg.buf !== undefined) buffer = named.get(arg.buf);
        else if (arg.img !== undefined) buffer = named.get(arg.img);
        else if (arg.img3d !== undefined) buffer = named.get(arg.img3d);
        else if (arg.data !== undefined) {
          // One buffer per data argument, shared by a pass's bands.
          buffer = dataBuffers.get(arg);
          if (!buffer) {
            const bytes = arg.data;
            buffer = device.createBuffer({
              size: align4(bytes.byteLength),
              usage: USAGE.STORAGE | USAGE.COPY_DST,
              mappedAtCreation: true
            });
            new Uint8Array(buffer.getMappedRange()).set(
              new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
            buffer.unmap();
            temporary.push(buffer);
            dataBuffers.set(arg, buffer);
          }
        }
        if (!buffer) throw new Error(pass.kernel + ': argument ' + decl.name + ' has no buffer');
        entries.push({ binding: entries.length, resource: { buffer: buffer } });
      });
      offset = Math.ceil(offset / 8) * 8;
      view.setUint32(offset, d.gx, true);
      view.setUint32(offset + 4, d.gy, true);
      entries.push({
        binding: entries.length,
        resource: { buffer: uniforms, offset: index * UNIFORM_SLOT, size: offset + 8 }
      });
      const p = this.pipeline(pass.kernel);
      return {
        pipeline: p.pipeline,
        bindGroup: device.createBindGroup({ layout: p.layout, entries: entries }),
        x: Math.ceil(d.gx / k.workgroup[0]),
        y: Math.ceil(d.gy / k.workgroup[1]),
        // Bands are submitted on their own.
        alone: d.row0 !== null
      };
    });
    device.queue.writeBuffer(uniforms, 0, uniformData);

    // Consecutive dispatches share a compute pass and a submission, except
    // bands, which each get their own.
    var encoder = device.createCommandEncoder();
    var compute = null;
    const flush = () => {
      if (compute) compute.end();
      compute = null;
      device.queue.submit([encoder.finish()]);
      encoder = device.createCommandEncoder();
    };
    for (const c of commands) {
      if (c.alone && compute) flush();
      if (!compute) compute = encoder.beginComputePass();
      compute.setPipeline(c.pipeline);
      compute.setBindGroup(0, c.bindGroup);
      compute.dispatchWorkgroups(c.x, c.y);
      if (c.alone) flush();
    }
    if (compute) compute.end();

    var output = named.get(plan.output);
    if (!output) throw new Error('The plan has no output buffer ' + plan.output);
    // A plan with nothing to do outputs its input; hand back a copy.
    const inputs = [src.buffer].concat(Object.keys(extras || {}).map((n) => extras[n].buffer));
    if (inputs.includes(output)) {
      output = device.createBuffer({ size: src.buffer.size, usage: PIXELS });
      encoder.copyBufferToBuffer(src.buffer, 0, output, 0, src.buffer.size);
    }
    device.queue.submit([encoder.finish()]);
    // Freed once the work that uses them is done.
    for (const b of temporary) b.destroy();
    return {
      buffer: output,
      width: outputSize ? outputSize.width : width,
      height: outputSize ? outputSize.height : height
    };
  }

  // Resolves with a copy of an image's pixels.
  async readPixels(image) {
    const size = image.width * image.height * 4;
    const staging = this.device.createBuffer({ size: align4(size), usage: USAGE.MAP_READ | USAGE.COPY_DST });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(image.buffer, 0, staging, 0, align4(size));
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(MAP_READ);
    const out = new Uint8Array(staging.getMappedRange(0, align4(size)).slice(0, size));
    staging.destroy();
    return out;
  }

  // Resolves once the GPU has finished everything submitted so far.
  done() {
    return this.device.queue.onSubmittedWorkDone();
  }

  destroy() {
    this.device.destroy();
  }
}

GpuEngine.USAGE = USAGE;
GpuEngine.PIXELS = PIXELS;

module.exports = { GpuEngine: GpuEngine };
