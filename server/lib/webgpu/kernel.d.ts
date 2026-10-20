// Types for kernel.js, for the TypeScript client.

export type ArgKind =
  | 'in'
  | 'out'
  | 'img'
  | 'imgf4'
  | 'f32s'
  | 'f32out'
  | 'i32s'
  | 'i32out'
  | 'u32s'
  | 'i32atomic'
  | 'u32atomic'
  | 'f4s'
  | 'f4out'
  | 'i2s'
  | 'bytes'
  | 'i32'
  | 'f32';

export interface KernelArg {
  name: string;
  kind: ArgKind;
}

export type Guard = '2d' | 'band' | 'none';

export interface KernelSpec {
  args: string;
  body: string;
  guard?: Guard;
  workgroup?: [number, number?, number?];
  barriers?: boolean;
  helpers?: string;
}

export interface Kernel {
  name: string;
  args: KernelArg[];
  // Buffer-like arguments in binding order, and scalars in uniform order.
  bindings: KernelArg[];
  scalars: KernelArg[];
  workgroup: [number, number, number];
  source: string;
}

export function isWritable(kind: ArgKind): boolean;
export function parseArgs(spec: string): KernelArg[];
export function makeKernel(name: string, spec: KernelSpec, common: string): Kernel;
// The WGSL helpers made for a buffer argument by name: at_NAME, nearest_NAME
// and the rest for pixels, f4_at_NAME and linear_NAME for float images,
// byte_NAME for bytes. (The WebGL2 engine translates them too.)
export function imageHelpers(name: string): string;
export function floatImageHelpers(name: string): string;
export function byteHelpers(name: string): string;
