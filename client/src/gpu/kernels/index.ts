// Every kernel with a WebGPU version, by its OpenCL name.
import { KernelSpec } from '../kernel';
import { ADJUST } from './adjust';
import { COLOUR } from './colour';
import { CONVOLVE } from './convolve';
import { GENERATIVE } from './generative';
import { BROWSER_ONLY } from './resize';
import { RETRO } from './retro';
import { STYLIZE } from './stylize';

export const KERNELS: Record<string, KernelSpec> = {
  ...COLOUR,
  ...CONVOLVE,
  ...STYLIZE,
  ...RETRO,
  ...ADJUST,
  ...GENERATIVE,
  ...BROWSER_ONLY,
};
