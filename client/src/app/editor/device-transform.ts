import { Injectable, signal } from '@angular/core';
import type { FullSizeProgress } from '../../gpu/full-size';
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
    // The browser has no WebGPU in a worker: the server may do it instead.
    readonly noGpu = false,
  ) {
    super(message);
  }
}

// Filters photos at full size on this device's GPU, in a Web Worker
// (src/gpu/full-size.worker.ts). One job at a time; cancel() ends it.
@Injectable({ providedIn: 'root' })
export class DeviceTransform {
  readonly progress = signal<FullSizeProgress | null>(null);
  private worker: Worker | null = null;
  private job = 0;
  private reject: ((err: Error) => void) | null = null;

  static supported(): boolean {
    return typeof Worker !== 'undefined' && typeof navigator !== 'undefined' && 'gpu' in navigator;
  }

  run(file: Blob, layers: StackLayer[], blendModes: string[]): Promise<DeviceResult> {
    if (!DeviceTransform.supported()) {
      return Promise.reject(
        new DeviceTransformError("This browser can't filter photos on its GPU.", true),
      );
    }
    this.cancel();
    const id = ++this.job;
    const worker = (this.worker ??= new Worker(new URL('../../gpu/full-size.worker', import.meta.url), {
      type: 'module',
    }));
    // For the end-to-end tests: pretend the GPU's buffers are this small.
    const maxBytes = (globalThis as { OMNIFILTER_DEVICE_MAX_BYTES?: number })
      .OMNIFILTER_DEVICE_MAX_BYTES;
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
        reject(new DeviceTransformError('Filtering failed: ' + (event.message || 'the worker stopped')));
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage({ id, file, layers, blendModes, maxBytes });
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
