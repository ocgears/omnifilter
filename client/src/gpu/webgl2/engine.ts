// The filter engine for browsers without WebGPU: the server's filter plans
// run with WebGL2, from the same WGSL kernels (see kernels.ts for how), so
// the live preview and full-size filtering work there too. It has the same
// surface as the WebGPU engine (engine-api.ts).
//
// Buffers are RGBA32UI textures, four 32-bit words per texel and ROW texels
// to a row, holding the same bytes a WebGPU buffer would. A kernel draws
// its output buffer; kernels that can't (cpu-kernels.ts) read their buffers
// back, run on the CPU and upload the result.
import type {
  AdapterInfo,
  NativePlan,
  PlanArg,
  PlanPass,
} from '../../../../server/lib/webgpu/engine';
import type { EngineImage, EngineLimits, FilterEngine } from '../engine-api';
import { KernelArg, KernelSpec, parseArgs } from '../../../../server/lib/webgpu/kernel';
import KERNELS from '../../../../server/lib/webgpu/kernels';
import { CPU_KERNELS, CpuArgs } from './cpu-kernels';
import { GlKernel, glKernel, glKernelKind, glKernelNames } from './kernels';
import { GLSL_PRELUDE, glslName } from './wgsl';

interface GlBuffer {
  tex: WebGLTexture;
  // Its size in 32-bit words, and its texture's size in texels.
  words: number;
  texW: number;
  texH: number;
}

export interface GlImage extends EngineImage {
  buffer: GlBuffer;
}

export interface GlEngineOptions {
  // Run banded passes (see Plan.band) a band at a time, so one long draw
  // on a big photo can't trip the GPU's watchdog.
  bands?: boolean;
}

interface Program {
  program: WebGLProgram;
  kernel: GlKernel | null;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

type Gl = WebGL2RenderingContext;
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const header = (row: number) =>
  '#version 300 es\nprecision highp float;\nprecision highp int;\n' +
  'precision highp usampler2D;\nconst int _TW = ' +
  row +
  ';\n' +
  GLSL_PRELUDE;

// A frame (in an RGBA8 texture) scaled to _w x _h pixels, bilinear.
const FROM_FRAME = (row: number) =>
  header(row) +
  `uniform highp sampler2D _tex;
uniform int _w;
uniform int _h;
out uvec4 _frag;
void main() {
  int t = int(gl_FragCoord.y) * _TW + int(gl_FragCoord.x);
  uvec4 r = uvec4(0u);
  for (int k = 0; k < 4; k++) {
    int o = t * 4 + k;
    if (o >= _w * _h) break;
    vec2 uv = (vec2(float(o % _w), float(o / _w)) + 0.5) / vec2(float(_w), float(_h));
    r[k] = _pack4x8unorm(textureLod(_tex, uv, 0.0));
  }
  _frag = r;
}
`;

const roundUp = (n: number, m: number) => Math.ceil(n / m) * m;

function cleanRenderer(renderer: string): string {
  // ANGLE (Intel Inc., Intel(R) Iris(TM) Graphics 6100, OpenGL 4.1): the GPU.
  const m =
    /^ANGLE \(([^,]*), ([^,]*?)(?: \(0x[0-9A-Fa-f]+\))?(?: Direct3D.*| OpenGL.*| Vulkan.*| Metal.*)?(?:, .*)?\)$/.exec(
      renderer,
    );
  // ANGLE on Metal says "ANGLE Metal Renderer: <the GPU>".
  return (m ? m[2] : renderer).replace(/^ANGLE \w+ Renderer: /, '').trim();
}

export class GlEngine implements FilterEngine {
  readonly backend = 'WebGL2' as const;
  readonly adapterInfo: AdapterInfo;
  readonly device: { lost: Promise<unknown>; limits: EngineLimits; destroy: () => void };
  lost = false;
  // Texels to a buffer's row; the largest buffer has as many rows as a
  // texture can.
  readonly row: number;
  private readonly maxTexture: number;
  private readonly programs = new Map<string, Program>();
  private readonly compiling = new Map<string, Promise<void>>();
  private readonly fbo: WebGLFramebuffer;
  private readonly fbo2: WebGLFramebuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vertex: WebGLShader;
  private readonly parallel: { COMPLETION_STATUS_KHR: number } | null;
  private frameTexture: WebGLTexture | null = null;
  private scratch: GlBuffer | null = null;
  private readonly bands: boolean;

  // A WebGL2 engine, or null where WebGL2 isn't available. Works in a Web
  // Worker (with OffscreenCanvas) too.
  static async create(options?: GlEngineOptions): Promise<GlEngine | null> {
    try {
      const attributes: WebGLContextAttributes = {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
      };
      let canvas: AnyCanvas | null = null;
      let gl: Gl | null = null;
      if (typeof OffscreenCanvas !== 'undefined') {
        canvas = new OffscreenCanvas(1, 1);
        gl = canvas.getContext('webgl2', attributes) as Gl | null;
      }
      if (!gl && typeof document !== 'undefined') {
        canvas = document.createElement('canvas');
        gl = canvas.getContext('webgl2', attributes);
      }
      return gl && canvas ? new GlEngine(gl, canvas, options) : null;
    } catch {
      return null;
    }
  }

  constructor(
    readonly gl: Gl,
    // Kept, since the context lives as long as its canvas.
    private readonly canvas: AnyCanvas,
    options: GlEngineOptions = {},
  ) {
    this.bands = Boolean(options.bands);
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.row = Math.min(this.maxTexture, 4096);
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(
      (debug && gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) ||
        gl.getParameter(gl.RENDERER) ||
        '',
    );
    const vendor = String(
      (debug && gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) || gl.getParameter(gl.VENDOR) || '',
    );
    const gpu = cleanRenderer(renderer);
    this.adapterInfo = {
      vendor,
      architecture: '',
      description: (gpu || "this device's GPU") + ' (WebGL2)',
      fallback: /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer),
    };
    // A buffer can be as big as a texture, up to WebGPU's usual 256 MB.
    const maxBytes = Math.min(this.row * this.maxTexture * 16, 256 * 1024 * 1024);
    let lostResolve: () => void = () => undefined;
    const lost = new Promise<void>((resolve) => (lostResolve = resolve));
    this.device = {
      lost,
      limits: {
        maxStorageBufferBindingSize: maxBytes,
        maxBufferSize: maxBytes,
        maxComputeWorkgroupsPerDimension: 65535,
        maxTextureDimension2D: this.maxTexture,
      },
      destroy: () => this.destroy(),
    };
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.lost = true;
      lostResolve();
    });
    this.parallel = gl.getExtension('KHR_parallel_shader_compile');
    this.fbo = gl.createFramebuffer()!;
    this.fbo2 = gl.createFramebuffer()!;
    this.vao = gl.createVertexArray()!;
    this.vertex = this.shader(gl.VERTEX_SHADER, VERTEX, 'vertex');
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  // ---- kernels ----

  static hasKernel(name: string): boolean {
    return glKernelKind(name) !== null;
  }

  static kernelNames(): string[] {
    return glKernelNames().filter((n) => GlEngine.hasKernel(n));
  }

  static unsupported(plan: NativePlan): string | null {
    for (const pass of plan.passes) {
      if (!GlEngine.hasKernel(pass.kernel)) return 'kernel ' + pass.kernel;
    }
    return null;
  }

  private shader(type: number, source: string, name: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader)
      throw new Error(
        'Could not make a shader for ' + name + (gl.isContextLost() ? ' (context lost)' : ''),
      );
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  }

  // Starts compiling a program; link() finishes it.
  private startProgram(name: string, source: string, kernel: GlKernel | null) {
    const gl = this.gl;
    const fragment = this.shader(gl.FRAGMENT_SHADER, source, name);
    const program = gl.createProgram()!;
    gl.attachShader(program, this.vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    return { name, program, fragment, kernel };
  }

  private link(started: ReturnType<GlEngine['startProgram']>): Program {
    const gl = this.gl;
    const { name, program, fragment, kernel } = started;
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getShaderInfoLog(fragment) || gl.getProgramInfoLog(program) || 'unknown error';
      gl.deleteProgram(program);
      gl.deleteShader(fragment);
      throw new Error(name + ': ' + log.trim());
    }
    gl.deleteShader(fragment);
    const p: Program = { program, kernel, uniforms: new Map() };
    this.programs.set(name, p);
    return p;
  }

  private kernelSource(name: string): { source: string; kernel: GlKernel } {
    const kernel = glKernel(name, this.row);
    return { source: kernel.source, kernel };
  }

  private program(name: string): Program {
    const found = this.programs.get(name);
    if (found) return found;
    const { source, kernel } = this.kernelSource(name);
    return this.link(this.startProgram(name, source, kernel));
  }

  private helperProgram(name: string, source: string): Program {
    return this.programs.get(name) ?? this.link(this.startProgram(name, source, null));
  }

  private uniform(p: Program, name: string): WebGLUniformLocation | null {
    let loc = p.uniforms.get(name);
    if (loc === undefined) {
      loc = this.gl.getUniformLocation(p.program, name);
      p.uniforms.set(name, loc);
    }
    return loc;
  }

  // Compiles kernels' programs in the background where the browser can
  // (KHR_parallel_shader_compile); run() then finds them ready.
  preparePipelines(names: string[]): Promise<void> {
    const gl = this.gl;
    const todo = Array.from(new Set(names)).filter(
      (n) => !this.programs.has(n) && !this.compiling.has(n) && glKernelKind(n) === 'gpu',
    );
    for (const name of todo) {
      let started: ReturnType<GlEngine['startProgram']>;
      try {
        const { source, kernel } = this.kernelSource(name);
        started = this.startProgram(name, source, kernel);
      } catch {
        // run() reports it.
        continue;
      }
      const done = new Promise<void>((resolve) => {
        const poll = () => {
          if (
            this.parallel &&
            !gl.isContextLost() &&
            !gl.getProgramParameter(started.program, this.parallel.COMPLETION_STATUS_KHR)
          ) {
            setTimeout(poll, 4);
            return;
          }
          try {
            if (!this.programs.has(name)) this.link(started);
          } catch {
            // run() compiles it again, and reports what's wrong.
          }
          this.compiling.delete(name);
          resolve();
        };
        poll();
      });
      this.compiling.set(name, done);
    }
    return Promise.all(names.map((n) => this.compiling.get(n))).then(() => undefined);
  }

  hasPipelines(names: string[]): boolean {
    return names.every((n) => this.programs.has(n) || glKernelKind(n) !== 'gpu');
  }

  // Compiles kernels now, and reports GLSL errors with the kernel's name.
  async prepare(names: string[]): Promise<void> {
    for (const name of names) {
      const kind = glKernelKind(name);
      if (kind === null) throw new Error('No WebGL2 version of the ' + name + ' kernel');
      if (kind === 'gpu') this.program(name);
    }
  }

  // ---- buffers ----

  private createBuffer(bytes: number): GlBuffer {
    const gl = this.gl;
    const words = Math.max(1, Math.ceil(bytes / 4));
    const texels = Math.ceil(words / 4);
    const texW = Math.min(this.row, texels);
    const texH = Math.ceil(texels / this.row);
    if (texH > this.maxTexture) {
      throw Object.assign(
        new Error('The GPU ran out of memory: a buffer of ' + bytes + ' bytes is too big'),
        {
          name: 'GpuError',
          outOfMemory: true,
        },
      );
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Starts out zeroed, as WebGPU's buffers do.
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, texW, texH);
    return { tex, words, texW, texH };
  }

  private deleteBuffer(buffer: GlBuffer): void {
    this.gl.deleteTexture(buffer.tex);
  }

  // Replaces a buffer's contents from the start with these bytes.
  private upload(buffer: GlBuffer, data: ArrayBufferView): void {
    const gl = this.gl;
    const padded = new Uint32Array(buffer.texW * buffer.texH * 4);
    const bytes = new Uint8Array(
      data.buffer,
      data.byteOffset,
      Math.min(data.byteLength, padded.byteLength),
    );
    new Uint8Array(padded.buffer).set(bytes);
    gl.bindTexture(gl.TEXTURE_2D, buffer.tex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      buffer.texW,
      buffer.texH,
      gl.RGBA_INTEGER,
      gl.UNSIGNED_INT,
      padded,
    );
  }

  // A buffer's words (a copy, with its texture's padding at the end).
  private readWords(buffer: GlBuffer): Uint32Array {
    const gl = this.gl;
    const out = new Uint32Array(buffer.texW * buffer.texH * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, buffer.tex, 0);
    gl.readPixels(0, 0, buffer.texW, buffer.texH, gl.RGBA_INTEGER, gl.UNSIGNED_INT, out);
    return out;
  }

  // Copies src's texels into dst (the same size or bigger).
  private copy(src: GlBuffer, dst: GlBuffer): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, src.tex, 0);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fbo2);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst.tex, 0);
    gl.blitFramebuffer(
      0,
      0,
      src.texW,
      src.texH,
      0,
      0,
      src.texW,
      src.texH,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  // A copy of a buffer, in a scratch texture kept for the next one.
  private snapshot(buffer: GlBuffer): GlBuffer {
    let s = this.scratch;
    if (!s || s.texW !== buffer.texW || s.texH !== buffer.texH) {
      if (s) this.deleteBuffer(s);
      s = this.scratch = this.createBuffer(buffer.words * 4);
    }
    this.copy(buffer, s);
    return s;
  }

  createImage(width: number, height: number, rgba?: ArrayBufferView): GlImage {
    const buffer = this.createBuffer(width * height * 4);
    if (rgba) this.upload(buffer, rgba);
    return { buffer, width, height };
  }

  release(image: EngineImage | null | undefined): void {
    if (image) this.deleteBuffer((image as GlImage).buffer);
  }

  // ---- running plans ----

  // Runs a plan on src (which it leaves alone) and returns a new image with
  // the result, as the WebGPU engine's run() does.
  run(
    plan: NativePlan,
    srcImage: EngineImage,
    extras?: Record<string, EngineImage>,
    outputSize?: { width: number; height: number },
  ): GlImage {
    const src = srcImage as GlImage;
    const width = src.width;
    const height = src.height;
    const named = new Map<string, GlBuffer>([['src', src.buffer]]);
    for (const name of Object.keys(extras ?? {}))
      named.set(name, (extras![name] as GlImage).buffer);
    const temporary: GlBuffer[] = [];
    try {
      for (const b of plan.buffers) {
        const buffer = this.createBuffer(b.bytes);
        if (b.name !== plan.output) temporary.push(buffer);
        if (b.init) this.upload(buffer, b.init);
        named.set(b.name, buffer);
      }
      const data = new Map<PlanArg, GlBuffer>();
      for (const pass of plan.passes) this.pass(pass, named, data, temporary, width, height);
      let output = named.get(plan.output);
      if (!output) throw new Error('The plan has no output buffer ' + plan.output);
      // A plan with nothing to do outputs its input; hand back a copy.
      const inputs = [
        src.buffer,
        ...Object.keys(extras ?? {}).map((n) => (extras![n] as GlImage).buffer),
      ];
      if (inputs.includes(output)) {
        const copy = this.createBuffer(output.words * 4);
        this.copy(output, copy);
        output = copy;
      }
      return {
        buffer: output,
        width: outputSize ? outputSize.width : width,
        height: outputSize ? outputSize.height : height,
      };
    } catch (err) {
      const out = named.get(plan.output);
      if (out && !temporary.includes(out) && out !== src.buffer) this.deleteBuffer(out);
      throw err;
    } finally {
      for (const b of temporary) this.deleteBuffer(b);
    }
  }

  private pass(
    pass: PlanPass,
    named: Map<string, GlBuffer>,
    data: Map<PlanArg, GlBuffer>,
    temporary: GlBuffer[],
    width: number,
    height: number,
  ): void {
    const kind = glKernelKind(pass.kernel);
    if (!kind) throw new Error('No WebGL2 version of the ' + pass.kernel + ' kernel');
    const global = pass.global ?? [width, height];
    const gx = global[0];
    const gy = global[1] ?? 1;
    const p = kind === 'gpu' ? this.program(pass.kernel) : null;
    const decls = p ? p.kernel!.args : cpuArgs(pass.kernel);
    if (pass.args.length !== decls.length) {
      throw new Error(
        pass.kernel + ' takes ' + decls.length + ' arguments, the plan gave ' + pass.args.length,
      );
    }
    const buffers = new Map<string, GlBuffer>();
    const scalars = new Map<string, number>();
    pass.args.forEach((arg, n) => {
      const decl = decls[n];
      if (decl.kind === 'i32' || decl.kind === 'f32') {
        const value = 'int' in arg ? arg.int : 'float' in arg ? arg.float : NaN;
        scalars.set(decl.name, decl.kind === 'i32' ? Math.round(value) : value);
        return;
      }
      let buffer: GlBuffer | undefined;
      if ('buf' in arg) buffer = named.get(arg.buf);
      else if ('img' in arg) buffer = named.get(arg.img);
      else if ('img3d' in arg) buffer = named.get(arg.img3d);
      else if ('data' in arg) {
        buffer = data.get(arg);
        if (!buffer) {
          buffer = this.createBuffer(arg.data.byteLength);
          temporary.push(buffer);
          this.upload(buffer, arg.data);
          data.set(arg, buffer);
        }
      }
      if (!buffer) throw new Error(pass.kernel + ': argument ' + decl.name + ' has no buffer');
      buffers.set(decl.name, buffer);
    });

    if (!p) {
      const args: CpuArgs = {
        words: (name) => this.readWords(buffers.get(name)!),
        store: (name, words) => this.upload(buffers.get(name)!, words),
        scalar: (name) => scalars.get(name)!,
        global: [gx, gy],
      };
      CPU_KERNELS[pass.kernel](args);
      return;
    }
    this.draw(p, pass, buffers, scalars, gx, gy);
  }

  private draw(
    p: Program,
    pass: PlanPass,
    buffers: Map<string, GlBuffer>,
    scalars: Map<string, number>,
    gx: number,
    gy: number,
  ): void {
    const gl = this.gl;
    const k = p.kernel!;
    const out = buffers.get(k.output.name)!;
    const per = k.perTexel;
    const elements = per === 4 ? out.words : Math.floor(out.words / 4);
    // Which elements the work-items write, as kernels.ts's main() maps them.
    let lo: number;
    let hi: number;
    let stride: number;
    let row0 = 0;
    let dx: number;
    let dy: number;
    let holes: boolean;
    if (k.guard === 'none') {
      stride = scalars.get(k.stride!)!;
      dx = gx;
      dy = gy;
      lo = 0;
      hi = stride * gy;
      holes = gx < stride;
    } else {
      // WebGPU runs whole work-groups; the kernel skips what's outside
      // width x height itself.
      stride = scalars.get('width')!;
      const h = scalars.get('height')!;
      row0 = k.guard === 'band' ? scalars.get('row0')! : 0;
      dx = roundUp(gx, k.workgroup[0]);
      dy = roundUp(gy, k.workgroup[1]);
      lo = Math.max(0, row0) * stride;
      hi = Math.min(h, row0 + dy) * stride;
      holes = dx < stride;
    }
    lo = Math.max(0, lo);
    hi = Math.min(hi, elements);
    if (hi <= lo || stride <= 0) return;
    // Texels whose elements are only partly written need the rest kept.
    const keep =
      per > 1 && (lo % per !== 0 || (hi % per !== 0 && hi < elements) || k.maySkip || holes);
    const old = keep ? this.snapshot(out) : null;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out.tex, 0);
    gl.viewport(0, 0, out.texW, out.texH);
    gl.useProgram(p.program);
    gl.bindVertexArray(this.vao);
    let unit = 0;
    for (const input of k.inputs) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, buffers.get(input.name)!.tex);
      gl.uniform1i(this.uniform(p, '_b_' + input.name), unit);
      unit++;
    }
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, old ? old.tex : null);
    gl.uniform1i(this.uniform(p, '_old'), unit);
    gl.uniform1i(this.uniform(p, '_keep'), old ? 1 : 0);
    for (const s of k.scalars) {
      const loc = this.uniform(p, glslName(s.name));
      if (s.kind === 'i32') gl.uniform1i(loc, scalars.get(s.name)!);
      else gl.uniform1f(loc, scalars.get(s.name)!);
    }
    gl.uniform1i(this.uniform(p, '_lo'), lo);
    gl.uniform1i(this.uniform(p, '_hi'), hi);
    gl.uniform1i(this.uniform(p, '_stride'), stride);
    gl.uniform1i(this.uniform(p, '_row0'), row0);
    gl.uniform1ui(this.uniform(p, '_dx'), dx);
    gl.uniform1ui(this.uniform(p, '_dy'), dy);

    // The texel rows holding [lo, hi), in bands of image rows if asked.
    const texelRow = (element: number) => Math.floor(element / per / this.row);
    const ranges: [number, number][] = [];
    if (this.bands && pass.band && k.guard === 'band') {
      for (let e = lo; e < hi; e += pass.band * stride)
        ranges.push([e, Math.min(hi, e + pass.band * stride)]);
    } else {
      ranges.push([lo, hi]);
    }
    gl.enable(gl.SCISSOR_TEST);
    let first = -1;
    for (const [a, b] of ranges) {
      // Neighbouring bands can share a texel row; each draws it once.
      const start = Math.max(texelRow(a), first + 1);
      const end = texelRow(b - 1);
      if (end < start) continue;
      gl.scissor(0, start, out.texW, end - start + 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (ranges.length > 1) gl.flush();
      first = end;
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Resolves with a copy of an image's pixels.
  async readPixels(image: EngineImage): Promise<Uint8Array> {
    const img = image as GlImage;
    const words = this.readWords(img.buffer);
    return new Uint8Array(words.buffer, 0, img.width * img.height * 4).slice();
  }

  // ---- drawing and frames ----

  // Shows an image on a canvas at its own size (CSS scales it), through
  // the CPU: reading the pixels back and putting them on a 2D canvas works
  // in every browser, where drawing a WebGL canvas onto another doesn't
  // (WebKit drew nothing). A preview-sized image takes a few milliseconds.
  present(image: EngineImage, target: AnyCanvas): void {
    const img = image as GlImage;
    const words = this.readWords(img.buffer);
    const pixels = new Uint8ClampedArray(
      words.buffer as ArrayBuffer,
      0,
      img.width * img.height * 4,
    );
    if (target.width !== img.width) target.width = img.width;
    if (target.height !== img.height) target.height = img.height;
    const ctx = target.getContext('2d') as
      CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error('No 2D canvas context to show the preview in');
    ctx.putImageData(new ImageData(pixels, img.width, img.height), 0, 0);
  }

  releaseFrame(): void {
    if (this.frameTexture) this.gl.deleteTexture(this.frameTexture);
    this.frameTexture = null;
  }

  // Copies a video frame (or bitmap, or canvas) to the GPU as an image of
  // width x height, scaling it there. Reuses `into` when it's that size.
  imageFromFrame(
    source: HTMLVideoElement | ImageBitmap | HTMLCanvasElement | OffscreenCanvas | VideoFrame,
    _sourceWidth: number,
    _sourceHeight: number,
    width: number,
    height: number,
    into?: EngineImage | null,
  ): GlImage {
    const gl = this.gl;
    // Made first: making it binds its texture, where the frame's goes next.
    const reuse = into && into.width === width && into.height === height;
    const image = reuse ? (into as GlImage) : this.createImage(width, height);
    if (!reuse) this.release(into);
    if (!this.frameTexture) {
      this.frameTexture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);

    const p = this.helperProgram('from frame', FROM_FRAME(this.row));
    const out = image.buffer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out.tex, 0);
    gl.viewport(0, 0, out.texW, out.texH);
    gl.useProgram(p.program);
    gl.bindVertexArray(this.vao);
    gl.uniform1i(this.uniform(p, '_tex'), 0);
    gl.uniform1i(this.uniform(p, '_w'), width);
    gl.uniform1i(this.uniform(p, '_h'), height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return image;
  }

  // ---- errors and waiting ----

  private glError(): { message: string; outOfMemory: boolean } | null {
    const gl = this.gl;
    if (gl.isContextLost()) return { message: 'the GPU was reset', outOfMemory: false };
    const code = gl.getError();
    if (code === gl.NO_ERROR) return null;
    // Later errors are about the same work.
    while (gl.getError() !== gl.NO_ERROR) {
      // drain
    }
    return {
      message: 'WebGL error 0x' + code.toString(16),
      outOfMemory: code === gl.OUT_OF_MEMORY,
    };
  }

  // Runs fn and throws a GpuError (outOfMemory set for running out) if the
  // GPU refused any of the work, as the WebGPU engine's checked() does.
  async checked<T>(fn: () => T | Promise<T>): Promise<T> {
    this.glError();
    let result: T | undefined;
    let thrown: unknown = null;
    try {
      result = await fn();
    } catch (e) {
      thrown = e;
    }
    const error = this.glError();
    if (thrown) throw thrown;
    if (error) {
      throw Object.assign(
        new Error(
          (error.outOfMemory ? 'The GPU ran out of memory' : 'The GPU refused the work') +
            ': ' +
            error.message,
        ),
        { name: 'GpuError', outOfMemory: error.outOfMemory, result },
      );
    }
    return result as T;
  }

  takeError(): { message: string } | null {
    return this.glError();
  }

  // Resolves once the GPU has finished everything asked of it so far.
  done(): Promise<void> {
    const gl = this.gl;
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    if (!sync) return Promise.resolve();
    return new Promise((resolve) => {
      const poll = () => {
        if (gl.isContextLost() || gl.getSyncParameter(sync, gl.SYNC_STATUS) === gl.SIGNALED) {
          gl.deleteSync(sync);
          resolve();
          return;
        }
        setTimeout(poll, 2);
      };
      poll();
    });
  }

  destroy(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

// A CPU kernel's argument list, from its WGSL declaration.
function cpuArgs(name: string): KernelArg[] {
  return parseArgs((KERNELS as Record<string, KernelSpec>)[name].args);
}
