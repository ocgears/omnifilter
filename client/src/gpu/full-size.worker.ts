// The Web Worker that filters photos at full size (full-size.ts), so the
// page keeps scrolling and answering taps meanwhile. It keeps one GPU
// engine for every job (compiling the kernels once): WebGPU's, or WebGL2's
// where there's no WebGPU (or the page asks for it, webgl2). It makes a new
// one if the device is lost. To cancel a job, the page ends the worker.
// With noGpu (WebKit has no WebGL2 in workers), the page does the job.
//
//   page -> worker: { id, file: Blob, layers, blendModes, maxBytes?, webgl2? }
//   worker -> page: { id, progress: { stage, done, total } }
//                   { id, result: { file: Blob, width, height, ranAt, device, timings } }
//                   { id, error, noGpu? }
import { GpuEngine } from './engine';
import type { FilterEngine } from './engine-api';
import { fullSizeJob, fullSizeMessage } from './full-size';
import type { StackLayer } from './stack';
import { GlEngine } from './webgl2/engine';

interface Job {
  id: number;
  file: Blob;
  layers: StackLayer[];
  blendModes: string[];
  maxBytes?: number;
  webgl2?: boolean;
}

let engine: Promise<FilterEngine | null> | null = null;

async function getEngine(webgl2: boolean): Promise<FilterEngine | null> {
  const current = engine ? await engine : null;
  if (!current || current.lost) {
    // Banded passes go one band at a time on a big photo (see engine.js).
    engine = (async () =>
      (webgl2 ? null : await GpuEngine.create({ bands: true })) ??
      (await GlEngine.create({ bands: true })))();
  }
  return engine!;
}

async function run(job: Job): Promise<void> {
  const send = (message: object, transfer: Transferable[] = []) =>
    postMessage({ id: job.id, ...message }, { transfer });
  const gpu = await getEngine(!!job.webgl2);
  if (!gpu) {
    send({ error: "This browser can't use the GPU from here.", noGpu: true });
    return;
  }
  try {
    const result = await fullSizeJob(gpu, job, (progress) => send({ progress }));
    send({ result });
  } catch (err) {
    send({ error: fullSizeMessage(gpu, err) });
  }
}

addEventListener('message', (event: MessageEvent<Job>) => {
  run(event.data);
});
