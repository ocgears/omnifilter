// Types for index.js: every kernel with a WebGPU version, by its OpenCL name.
import { KernelSpec } from '../kernel';

declare const KERNELS: Record<string, KernelSpec>;
export = KERNELS;
