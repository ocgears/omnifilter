import { Injectable, signal } from '@angular/core';
import type { FullSizeJob, FullSizeProgress } from '../../gpu/full-size';
import type { StackLayer } from '../../gpu';

// A photo filtered on this device's GPU at full size.
export interface DeviceResult {
  file: Blob;
  width: number;
  height: number;
  // The size the filters ran at, when the GPU's limits needed a smaller one.
  ranAt: { width: number; height: number } | null;
  // The GPU, as the browser names it.
  device: string;
  // Milliseconds: decoding, onto the GPU, the filters, off it, encoding.
  timings: {
    decode: number;
    upload: number;
    filters: number;
    readback: number;
    encode: number;
    total: number;
  };
}

export class DeviceTransformError extends Error {
  constructor(
    message: string,
    // The browser has no WebGPU or WebGL2 here: the server may do it
    // instead.
    readonly noGpu = false,
  ) {
    super(message);
  }
}

// Filters photos at full size on this device's GPU, in a Web Worker
// (src/gpu/full-size.worker.ts), or on the page itself where the browser
// has a GPU only there (WebKit has WebGL2 on the page but not in workers).
// One job at a time; cancel() ends it.
@Injectable({ providedIn: 'root' })
export class DeviceTransform {
  readonly progress = signal<FullSizeProgress | null>(null);
  private worker: Worker | null = null;
  private job = 0;
  private reject: ((err: Error) => void) | null = null;
  // Set once the worker has found no GPU: jobs run on the page from then.
  private onPage = false;

  // Whether the browser can have a GPU for this: WebGPU, or WebGL2 with
  // OffscreenCanvas (which encodes the result). The engine finds out for
  // sure.
  static supported(): boolean {
    if (typeof Worker === 'undefined' || typeof navigator === 'undefined') return false;
    const webgl2 =
      typeof WebGL2RenderingContext !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
    return 'gpu' in navigator || webgl2;
  }

  async run(file: Blob, layers: StackLayer[], blendModes: string[]): Promise<DeviceResult> {
    if (!DeviceTransform.supported()) {
      throw new DeviceTransformError("This browser can't filter photos on its GPU.", true);
    }
    this.cancel();
    const id = ++this.job;
    const job: FullSizeJob & { webgl2: boolean } = {
      file,
      layers,
      blendModes,
      // For the end-to-end tests: pretend the GPU's buffers are this small...
      maxBytes: (globalThis as { OMNIFILTER_DEVICE_MAX_BYTES?: number })
        .OMNIFILTER_DEVICE_MAX_BYTES,
      // ...and use WebGL2 where there's WebGPU.
      webgl2: !!(globalThis as { OMNIFILTER_FORCE_WEBGL2?: boolean }).OMNIFILTER_FORCE_WEBGL2,
    };
    if (!this.onPage) {
      try {
        return await this.inWorker(id, job);
      } catch (err) {
        if (!(err instanceof DeviceTransformError && err.noGpu)) throw err;
        this.end();
        this.onPage = true;
      }
    }
    return this.inPage(id, job);
  }

  private inWorker(id: number, job: FullSizeJob & { webgl2: boolean }): Promise<DeviceResult> {
    const worker = (this.worker ??= new Worker(
      new URL('../../gpu/full-size.worker', import.meta.url),
      {
        type: 'module',
      },
    ));
    return new Promise<DeviceResult>((resolve, reject) => {
      this.reject = reject;
      const done = () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        this.progress.set(null);
        this.reject = null;
      };
      const onMessage = (event: MessageEvent) => {
        const data = event.data;
        if (data.id !== id) return;
        if (data.progress) {
          this.progress.set(data.progress);
          return;
        }
        done();
        if (data.result) resolve(data.result as DeviceResult);
        else reject(new DeviceTransformError(data.error, !!data.noGpu));
      };
      const onError = (event: ErrorEvent) => {
        done();
        this.end();
        reject(
          new DeviceTransformError('Filtering failed: ' + (event.message || 'the worker stopped')),
        );
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage({ id, ...job });
    });
  }

  // The same job with the page's own GPU engine (the live preview's): the
  // page is busy while each layer runs, but it works where workers have no
  // GPU.
  private async inPage(id: number, job: FullSizeJob): Promise<DeviceResult> {
    const [{ gpuEngine }, { fullSizeJob, fullSizeMessage }] = await Promise.all([
      import('../../gpu'),
      import('../../gpu/full-size'),
    ]);
    const engine = await gpuEngine();
    if (!engine) {
      throw new DeviceTransformError("This browser can't filter photos on its GPU.", true);
    }
    return new Promise<DeviceResult>((resolve, reject) => {
      this.reject = reject;
      // cancel() lets go of reject, and a newer job replaces it.
      const cancelled = () => this.job !== id || this.reject !== reject;
      const finish = () => {
        this.progress.set(null);
        this.reject = null;
      };
      fullSizeJob(
        engine,
        job,
        (p) => {
          if (!cancelled()) this.progress.set(p);
        },
        cancelled,
      ).then(
        (result) => {
          if (cancelled()) return;
          finish();
          resolve(result);
        },
        (err) => {
          if (cancelled()) return;
          finish();
          reject(new DeviceTransformError(fullSizeMessage(engine, err)));
        },
      );
    });
  }

  // Stops the job in progress, if any (its promise rejects).
  cancel(): void {
    if (!this.reject) return;
    const reject = this.reject;
    this.reject = null;
    this.progress.set(null);
    this.end();
    reject(new DeviceTransformError('Cancelled.'));
  }

  private end(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
