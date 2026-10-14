import { Injectable } from '@angular/core';
import { GpuEngine, StackLayer, gpuEngine } from '../../gpu';
import { Layer } from '../models';

// A photo decoded for previewing: straight-alpha RGBA at a reduced size,
// and the size of the full photo the server will filter.
export interface PreviewPhoto {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  fullWidth: number;
  fullHeight: number;
}

// The editor's layers as the GPU stack takes them: layers without a filter
// are skipped, as when transforming.
export function stackLayers(layers: readonly Layer[]): StackLayer[] {
  return layers
    .filter((l): l is Layer & { tOption: string } => !!l.tOption)
    .map((l) => ({ tOption: l.tOption, params: l.params, amount: l.amount, blend: l.blend }));
}

// Decodes a photo (a data URL) to pixels whose longer side is at most
// maxSide. The browser applies the EXIF orientation, as the server does, and
// decodes straight to the smaller size, which matters for 24-megapixel phone
// photos in a phone browser's memory.
export async function decodePhoto(dataUrl: string, maxSide: number): Promise<PreviewPhoto> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const fullWidth = img.naturalWidth;
  const fullHeight = img.naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(fullWidth, fullHeight));
  const width = Math.max(1, Math.round(fullWidth * scale));
  const height = Math.max(1, Math.round(fullHeight * scale));
  const bitmap = await createImageBitmap(img, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: 'high',
  });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, width, height).data;
  return { rgba, width, height, fullWidth, fullHeight };
}

// The page's WebGPU engine, shared by the live preview and the thumbnails.
@Injectable({ providedIn: 'root' })
export class PreviewEngine {
  // null where WebGPU isn't available. A lost device gets replaced.
  get(): Promise<GpuEngine | null> {
    return gpuEngine();
  }
}
