// The filter engine in the browser: the shared WebGPU engine that runs the
// server's filter plans (server/lib/webgpu/engine.js, which the server's
// WebGPU backend uses too), plus drawing to a canvas and taking camera
// frames. Knows nothing about Angular, so it can be used and tested on its own.
import { GpuEngine as CoreEngine, GpuImage } from '../../../server/lib/webgpu/engine';

export type {
  GpuImage,
  NativePlan,
  PlanArg,
  PlanBuffer,
  PlanPass,
} from '../../../server/lib/webgpu/engine';

const USAGE = CoreEngine.USAGE;

// Turns a frame copied into a texture (a video frame, a bitmap) into an
// RGBA8 buffer image, scaled to the buffer's size with bilinear filtering.
// Browsers hand over video frames with straight alpha (copyExternalImage-
// ToTexture's default).
const FROM_TEXTURE = /* wgsl */ `
@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<uniform> size: vec2u;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  let uv = (vec2f(gid.xy) + 0.5) / vec2f(size);
  let c = textureSampleLevel(tex, smp, uv, 0.0);
  let v = vec4u(round(clamp(c * 255.0, vec4f(0.0), vec4f(255.0))));
  dst[gid.y * size.x + gid.x] = v.x | (v.y << 8u) | (v.z << 16u) | (v.w << 24u);
}
`;

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

export class GpuEngine extends CoreEngine {
  private presentPipeline: { pipeline: GPURenderPipeline; format: GPUTextureFormat } | null = null;
  private fromTexture: { pipeline: GPUComputePipeline; sampler: GPUSampler } | null = null;
  private frameTexture: GPUTexture | null = null;

  // A WebGPU engine on this device's GPU, or null where WebGPU isn't
  // available.
  static async create(): Promise<GpuEngine | null> {
    try {
      return await GpuEngine.fromGpu((navigator as Navigator & { gpu?: GPU }).gpu);
    } catch {
      return null;
    }
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
      usage: USAGE.UNIFORM | USAGE.COPY_DST,
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

  // Copies a video frame (or bitmap, or canvas) to the GPU as an image of
  // width x height, scaling it there. Reuses `into` when it's that size.
  imageFromFrame(
    source: HTMLVideoElement | ImageBitmap | HTMLCanvasElement | OffscreenCanvas | VideoFrame,
    sourceWidth: number,
    sourceHeight: number,
    width: number,
    height: number,
    into?: GpuImage | null,
  ): GpuImage {
    const { device } = this;
    let texture = this.frameTexture;
    if (!texture || texture.width !== sourceWidth || texture.height !== sourceHeight) {
      texture?.destroy();
      texture = this.frameTexture = device.createTexture({
        size: [sourceWidth, sourceHeight],
        format: 'rgba8unorm',
        // TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT (copyExternalImage-
        // ToTexture needs the last).
        usage: 0x04 | 0x02 | 0x10,
      });
    }
    device.queue.copyExternalImageToTexture({ source }, { texture }, [sourceWidth, sourceHeight]);
    if (!this.fromTexture) {
      const module = device.createShaderModule({ code: FROM_TEXTURE, label: 'from texture' });
      this.fromTexture = {
        pipeline: device.createComputePipeline({
          label: 'from texture',
          layout: 'auto',
          compute: { module, entryPoint: 'main' },
        }),
        sampler: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
      };
    }
    const image =
      into && into.width === width && into.height === height
        ? into
        : this.createImage(width, height);
    if (image !== into) this.release(into);
    const size = device.createBuffer({
      size: 8,
      usage: USAGE.UNIFORM | USAGE.COPY_DST,
    });
    device.queue.writeBuffer(size, 0, new Uint32Array([width, height]));
    const { pipeline, sampler } = this.fromTexture;
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: texture.createView() },
          { binding: 1, resource: sampler },
          { binding: 2, resource: { buffer: image.buffer } },
          { binding: 3, resource: { buffer: size } },
        ],
      }),
    );
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    device.queue.submit([encoder.finish()]);
    size.destroy();
    return image;
  }
}
