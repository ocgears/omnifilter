import { Injectable } from '@angular/core';
import type { GpuEngine, StackLayer } from '../../gpu';
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

// The longer side of the copy the live preview filters: about what a phone
// or laptop screen shows, so filters run in milliseconds. The server always
// filters the full photo.
export const PREVIEW_SIZE = 1024;

// The last photo decoded at PREVIEW_SIZE: the live preview and the preset
// thumbnails both start from it, so a 12-megapixel photo is decoded once.
let lastPreview: { source: string; photo: Promise<PreviewPhoto> } | null = null;

export function previewPhoto(dataUrl: string): Promise<PreviewPhoto> {
  if (lastPreview?.source !== dataUrl) {
    const photo = decodePhoto(dataUrl, PREVIEW_SIZE);
    lastPreview = { source: dataUrl, photo };
    photo.catch(() => {
      if (lastPreview?.photo === photo) lastPreview = null;
    });
  }
  return lastPreview.photo;
}

// A smaller copy of a decoded photo, at most maxSide on its longer side.
export async function smallerPhoto(photo: PreviewPhoto, maxSide: number): Promise<PreviewPhoto> {
  const scale = Math.min(1, maxSide / Math.max(photo.width, photo.height));
  const width = Math.max(1, Math.round(photo.width * scale));
  const height = Math.max(1, Math.round(photo.height * scale));
  if (width === photo.width && height === photo.height) return photo;
  const pixels = new ImageData(new Uint8ClampedArray(photo.rgba), photo.width, photo.height);
  const bitmap = await createImageBitmap(pixels, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: 'high',
    premultiplyAlpha: 'none',
  });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, width, height).data;
  return { rgba, width, height, fullWidth: photo.fullWidth, fullHeight: photo.fullHeight };
}

// The page's WebGPU engine, shared by the live preview and the thumbnails.
// The GPU code is a chunk of its own, loaded the first time it's asked for.
@Injectable({ providedIn: 'root' })
export class PreviewEngine {
  // null where WebGPU isn't available. A lost device gets replaced.
  async get(): Promise<GpuEngine | null> {
    const { gpuEngine } = await import('../../gpu');
    return gpuEngine();
  }
}
