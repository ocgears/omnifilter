// The Web Worker that filters photos at full size (full-size.ts), so the
// page keeps scrolling and answering taps meanwhile. It keeps one GPU
// engine for every job (compiling the kernels once), and makes a new one if
// the device is lost. To cancel a job, the page ends the worker.
//
//   page -> worker: { id, file: Blob, layers, blendModes, maxBytes? }
//   worker -> page: { id, progress: { stage, done, total } }
//                   { id, result: { file: Blob, width, height, ranAt, device, timings } }
//                   { id, error, noGpu? }
import { GpuEngine } from './engine';
import { FullSizeError, deviceLimits, encodePixels, filterFullSize } from './full-size';
import type { StackLayer } from './stack';

interface Job {
  id: number;
  file: Blob;
  layers: StackLayer[];
  blendModes: string[];
  maxBytes?: number;
}

let engine: Promise<GpuEngine | null> | null = null;

async function getEngine(): Promise<GpuEngine | null> {
  const current = engine ? await engine : null;
  if (!current || current.lost) {
    // Banded passes go one band at a time on a big photo (see engine.js).
    engine = GpuEngine.create({ bands: true });
  }
  return engine!;
}

async function run(job: Job): Promise<void> {
  const send = (message: object, transfer: Transferable[] = []) =>
    postMessage({ id: job.id, ...message }, { transfer });
  const gpu = await getEngine();
  if (!gpu) {
    send({ error: "This browser can't use the GPU from here.", noGpu: true });
    return;
  }
  const started = performance.now();
  try {
    let t = performance.now();
    // Applies the photo's EXIF orientation, as the server does.
    const bitmap = await createImageBitmap(job.file, { imageOrientation: 'from-image' });
    const decode = performance.now() - t;
    let out;
    try {
      out = await filterFullSize(gpu, bitmap, job.layers, job.blendModes, {
        maxBytes: job.maxBytes,
        onProgress: (progress) => send({ progress }),
      });
    } finally {
      bitmap.close();
    }
    t = performance.now();
    send({ progress: { stage: 'encode', done: job.layers.length, total: job.layers.length } });
    const file = await encodePixels(out.rgba, out.rgbaWidth, out.rgbaHeight, out.width, out.height);
    const encode = performance.now() - t;
    send({
      result: {
        file,
        width: out.width,
        height: out.height,
        ranAt: out.ranAt,
        device: deviceLimits(gpu).name,
        timings: { decode, ...out.timings, encode, total: performance.now() - started },
      },
    });
  } catch (err) {
    const lost = gpu.lost ? ' (the GPU was reset; try again)' : '';
    const message =
      err instanceof FullSizeError ? err.message : 'Filtering failed: ' + (err as Error).message;
    send({ error: message + lost });
  }
}

addEventListener('message', (event: MessageEvent<Job>) => {
  run(event.data);
});
