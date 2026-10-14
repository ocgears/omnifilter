// Runs filter plans (the format server/lib/filters builds and
// native/omnifilter.cpp runs with OpenCL) on the viewer's GPU with WebGPU.
// Knows nothing about Angular, so it can be used and tested on its own.
import { COMMON } from './common';
import { Kernel, KernelSpec, isWritable, makeKernel } from './kernel';
import { KERNELS } from './kernels';

export interface PlanBuffer {
  name: string;
  bytes: number;
  init?: ArrayBufferView;
  zero?: boolean;
}

export type PlanArg =
  | { buf: string }
  | { img: string; width?: number; height?: number; format?: 'rgba8' | 'rgba32f' }
  | { img3d: string; size: number }
  | { int: number }
  | { float: number }
  | { data: ArrayBufferView };

export interface PlanPass {
  kernel: string;
  args: PlanArg[];
  global?: number[];
  local?: number[];
  band?: number;
}

export interface NativePlan {
  buffers: PlanBuffer[];
  passes: PlanPass[];
  output: string;
}

// An RGBA8 image on the GPU, straight alpha, row by row.
export interface GpuImage {
  buffer: GPUBuffer;
  width: number;
  height: number;
}

const UNIFORM_SLOT = 256;
// A function: GPUBufferUsage isn't defined where WebGPU isn't (unit tests,
// older browsers), and this module still loads there.
const pixelUsage = () => GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;

const align4 = (n: number) => Math.max(4, Math.ceil(n / 4) * 4);

const PRESENT = /* wgsl */ `
@group(0) @binding(0) var<storage, read> img: array<u32>;
@group(0) @binding(1) var<uniform> size: vec2u;
@vertex fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((v << 1u) & 2u), f32(v & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let x = min(u32(pos.x), size.x - 1u);
  let y = min(u32(pos.y), size.y - 1u);
  let c = unpack4x8unorm(img[y * size.x + x]);
  return vec4f(c.rgb * c.a, c.a);
}
`;

export class GpuEngine {
  private readonly kernels = new Map<string, Kernel>();
  private readonly pipelines = new Map<
    string,
    { pipeline: GPUComputePipeline; layout: GPUBindGroupLayout }
  >();
  private presentPipeline: { pipeline: GPURenderPipeline; format: GPUTextureFormat } | null = null;
  // Set when the device is lost (driver reset, tab in the background too
  // long on some phones); the owner should make a new engine.
  lost = false;

  private constructor(
    readonly device: GPUDevice,
    readonly adapterInfo: { vendor: string; architecture: string; fallback: boolean },
  ) {
    device.lost.then(() => (this.lost = true));
  }

  // A WebGPU engine, or null where WebGPU isn't available.
  static async create(): Promise<GpuEngine | null> {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    if (!gpu) return null;
    try {
      const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return null;
      const device = await adapter.requestDevice({
        requiredLimits: {
          maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
          maxBufferSize: adapter.limits.maxBufferSize,
        },
      });
      const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
      return new GpuEngine(device, {
        vendor: info?.vendor ?? '',
        architecture: info?.architecture ?? '',
        fallback: !!(info as { isFallbackAdapter?: boolean } | undefined)?.isFallbackAdapter,
      });
    } catch {
      return null;
    }
  }

  // Whether there's a WGSL version of an OpenCL kernel.
  static hasKernel(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(KERNELS, name);
  }

  // Why this engine can't run a plan (a kernel or argument it doesn't have),
  // or null if it can.
  static unsupported(plan: NativePlan): string | null {
    for (const pass of plan.passes) {
      if (!GpuEngine.hasKernel(pass.kernel)) return 'kernel ' + pass.kernel;
    }
    return null;
  }

  kernel(name: string): Kernel {
    let k = this.kernels.get(name);
    if (!k) {
      const spec: KernelSpec | undefined = KERNELS[name];
      if (!spec) throw new Error('No WebGPU version of the ' + name + ' kernel');
      k = makeKernel(name, spec, COMMON);
      this.kernels.set(name, k);
    }
    return k;
  }

  private pipeline(name: string) {
    let p = this.pipelines.get(name);
    if (!p) {
      const k = this.kernel(name);
      const entries: GPUBindGroupLayoutEntry[] = k.bindings.map((b, i) => ({
        binding: i,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: isWritable(b.kind) ? 'storage' : 'read-only-storage' },
      }));
      entries.push({
        binding: k.bindings.length,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform' },
      });
      const layout = this.device.createBindGroupLayout({ entries });
      const module = this.device.createShaderModule({ code: k.source, label: name });
      const pipeline = this.device.createComputePipeline({
        label: name,
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint: 'main' },
      });
      p = { pipeline, layout };
      this.pipelines.set(name, p);
    }
    return p;
  }

  // Compiles the kernels a plan uses ahead of time (they compile on first use
  // otherwise), and reports WGSL errors with the kernel's name.
  async prepare(names: string[]): Promise<void> {
    for (const name of names) {
      const k = this.kernel(name);
      const module = this.device.createShaderModule({ code: k.source, label: name });
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((m) => m.type === 'error');
      if (errors.length) {
        throw new Error(
          name + ': ' + errors.map((e) => 'line ' + e.lineNum + ': ' + e.message).join('; '),
        );
      }
      this.pipeline(name);
    }
  }

  createImage(width: number, height: number, rgba?: ArrayBufferView): GpuImage {
    const buffer = this.device.createBuffer({
      size: align4(width * height * 4),
      usage: pixelUsage(),
    });
    if (rgba)
      this.device.queue.writeBuffer(buffer, 0, rgba.buffer, rgba.byteOffset, rgba.byteLength);
    return { buffer, width, height };
  }

  release(image: GpuImage | null | undefined): void {
    image?.buffer.destroy();
  }

  // Runs a plan on src (which it leaves alone) and returns a new image with
  // the result; the caller releases it. extras are more input images, by the
  // buffer names the plan uses for them. The plan works on src's size, and
  // so does its output unless outputSize says otherwise.
  run(
    plan: NativePlan,
    src: GpuImage,
    extras: Record<string, GpuImage> = {},
    outputSize?: { width: number; height: number },
  ): GpuImage {
    const { device } = this;
    const width = src.width;
    const height = src.height;
    const named = new Map<string, GPUBuffer>([['src', src.buffer]]);
    for (const [name, image] of Object.entries(extras)) named.set(name, image.buffer);
    const temporary: GPUBuffer[] = [];
    const encoder = device.createCommandEncoder();
    for (const b of plan.buffers) {
      const buffer = device.createBuffer({ size: align4(b.bytes), usage: pixelUsage() });
      if (b.init)
        device.queue.writeBuffer(buffer, 0, b.init.buffer, b.init.byteOffset, b.init.byteLength);
      named.set(b.name, buffer);
      if (b.name !== plan.output) temporary.push(buffer);
    }

    const uniforms = device.createBuffer({
      size: Math.max(1, plan.passes.length) * UNIFORM_SLOT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    temporary.push(uniforms);
    const uniformData = new ArrayBuffer(Math.max(1, plan.passes.length) * UNIFORM_SLOT);

    const compute = encoder.beginComputePass();
    plan.passes.forEach((pass, index) => {
      const k = this.kernel(pass.kernel);
      if (pass.args.length !== k.args.length) {
        throw new Error(
          pass.kernel + ' takes ' + k.args.length + ' arguments, the plan gave ' + pass.args.length,
        );
      }
      const global = pass.global ?? [width, height];
      const gx = global[0];
      const gy = global[1] ?? 1;

      // Scalars, in declaration order, then the global size (8-aligned).
      const view = new DataView(uniformData, index * UNIFORM_SLOT, UNIFORM_SLOT);
      let offset = 0;
      const entries: GPUBindGroupEntry[] = [];
      pass.args.forEach((arg, n) => {
        const decl = k.args[n];
        if (decl.kind === 'i32' || decl.kind === 'f32') {
          const value = 'int' in arg ? arg.int : 'float' in arg ? arg.float : NaN;
          if (decl.kind === 'i32') view.setInt32(offset, Math.round(value), true);
          else view.setFloat32(offset, value, true);
          offset += 4;
          return;
        }
        let buffer: GPUBuffer | undefined;
        if ('buf' in arg) buffer = named.get(arg.buf);
        else if ('img' in arg) buffer = named.get(arg.img);
        else if ('img3d' in arg) buffer = named.get(arg.img3d);
        else if ('data' in arg) {
          const bytes = arg.data;
          buffer = device.createBuffer({
            size: align4(bytes.byteLength),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            mappedAtCreation: true,
          });
          new Uint8Array(buffer.getMappedRange()).set(
            new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          );
          buffer.unmap();
          temporary.push(buffer);
        }
        if (!buffer) throw new Error(pass.kernel + ': argument ' + decl.name + ' has no buffer');
        entries.push({ binding: entries.length, resource: { buffer } });
      });
      offset = Math.ceil(offset / 8) * 8;
      view.setUint32(offset, gx, true);
      view.setUint32(offset + 4, gy, true);
      entries.push({
        binding: entries.length,
        resource: { buffer: uniforms, offset: index * UNIFORM_SLOT, size: offset + 8 },
      });

      const { pipeline, layout } = this.pipeline(pass.kernel);
      compute.setPipeline(pipeline);
      compute.setBindGroup(0, device.createBindGroup({ layout, entries }));
      compute.dispatchWorkgroups(Math.ceil(gx / k.workgroup[0]), Math.ceil(gy / k.workgroup[1]));
    });
    compute.end();
    device.queue.writeBuffer(uniforms, 0, uniformData);

    let output = named.get(plan.output);
    if (!output) throw new Error('The plan has no output buffer ' + plan.output);
    // A plan with nothing to do outputs its input; hand back a copy.
    if (output === src.buffer || Object.values(extras).some((e) => e.buffer === output)) {
      output = device.createBuffer({ size: src.buffer.size, usage: pixelUsage() });
      encoder.copyBufferToBuffer(src.buffer, 0, output, 0, src.buffer.size);
    }
    device.queue.submit([encoder.finish()]);
    // Freed once the work that uses them is done.
    for (const b of temporary) b.destroy();
    return {
      buffer: output,
      width: outputSize?.width ?? width,
      height: outputSize?.height ?? height,
    };
  }

  async readPixels(image: GpuImage): Promise<Uint8Array> {
    const size = image.width * image.height * 4;
    const staging = this.device.createBuffer({
      size: align4(size),
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(image.buffer, 0, staging, 0, align4(size));
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = new Uint8Array(staging.getMappedRange(0, align4(size)).slice(0, size));
    staging.destroy();
    return out;
  }

  // Draws an image onto a canvas at its own size (CSS scales it).
  present(image: GpuImage, canvas: HTMLCanvasElement | OffscreenCanvas): void {
    const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!context) throw new Error('No WebGPU canvas context');
    const format = navigator.gpu.getPreferredCanvasFormat();
    if (canvas.width !== image.width) canvas.width = image.width;
    if (canvas.height !== image.height) canvas.height = image.height;
    context.configure({ device: this.device, format, alphaMode: 'premultiplied' });
    if (!this.presentPipeline || this.presentPipeline.format !== format) {
      const module = this.device.createShaderModule({ code: PRESENT, label: 'present' });
      this.presentPipeline = {
        format,
        pipeline: this.device.createRenderPipeline({
          label: 'present',
          layout: 'auto',
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        }),
      };
    }
    const size = this.device.createBuffer({
      size: 8,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(size, 0, new Uint32Array([image.width, image.height]));
    const { pipeline } = this.presentPipeline;
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: image.buffer } },
          { binding: 1, resource: { buffer: size } },
        ],
      }),
    );
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    size.destroy();
  }

  // Resolves once the GPU has finished everything submitted so far.
  done(): Promise<void> {
    return this.device.queue.onSubmittedWorkDone();
  }

  destroy(): void {
    this.device.destroy();
  }
}
