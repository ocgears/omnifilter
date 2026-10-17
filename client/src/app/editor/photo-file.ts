// Reading a picked, dropped or pasted image file into a data URL, which is
// what the API takes.

// POST /newcontent takes bodies up to 16 MB, and base64 makes a file a third
// bigger, so leave room for that and the filter settings.
export const MAX_FILE_BYTES = 11_500_000;

export class PhotoFileError extends Error {}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string' && reader.result
        ? resolve(reader.result)
        : reject(new PhotoFileError('Could not read that file.'));
    reader.onerror = () => reject(new PhotoFileError('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

// Whether this browser can show the image. Chrome on Android, for one, can
// hand over HEIC photos that it can't display, and the server can't read
// them either.
function decodes(dataUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0);
    img.onerror = () => resolve(false);
    img.src = dataUrl;
  });
}

export async function readPhoto(file: File): Promise<string> {
  if (file.type && !file.type.startsWith('image/')) {
    throw new PhotoFileError("That isn't an image file.");
  }
  if (file.size > MAX_FILE_BYTES) {
    const mb = (file.size / 1e6).toFixed(1);
    throw new PhotoFileError(
      'That photo is ' + mb + ' MB; the limit is ' + MAX_FILE_BYTES / 1e6 + ' MB.',
    );
  }
  const dataUrl = await readAsDataUrl(file);
  if (!(await decodes(dataUrl))) {
    throw new PhotoFileError(
      "This browser can't open that image. HEIC photos from some phones can't be used; " +
        'try a JPEG, PNG or WebP.',
    );
  }
  return dataUrl;
}

function load(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new PhotoFileError('Could not read that photo.'));
    img.src = dataUrl;
  });
}

// The photo scaled down to at most maxPixels pixels, as a JPEG, or as it is
// if it's no bigger than that. For guests, whose photos the server takes
// only up to a smaller size.
export async function fitPhoto(dataUrl: string, maxPixels: number): Promise<string> {
  const img = await load(dataUrl);
  const pixels = img.naturalWidth * img.naturalHeight;
  if (!pixels || pixels <= maxPixels) return dataUrl;
  const scale = Math.sqrt(maxPixels / pixels);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.floor(img.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) return dataUrl;
  context.imageSmoothingQuality = 'high';
  context.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.92);
}

// The first image file in a drop or paste, if any.
export function imageFrom(items: DataTransfer | null): File | null {
  if (!items) return null;
  for (const file of Array.from(items.files)) {
    if (file.type.startsWith('image/')) return file;
  }
  return null;
}

// A photo (a file or a data URL) drawn at most maxSide pixels on its longer
// side, or null if it's no bigger than that or the browser can't.
async function drawnAtMost(
  source: Blob | string,
  maxSide: number,
): Promise<{ canvas: HTMLCanvasElement; width: number; height: number } | null> {
  const blob = typeof source === 'string' ? await (await fetch(source)).blob() : source;
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    const side = Math.max(bitmap.width, bitmap.height);
    if (side <= maxSide) return null;
    const k = maxSide / side;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * k));
    canvas.height = Math.max(1, Math.round(bitmap.height * k));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { canvas, width: canvas.width, height: canvas.height };
  } finally {
    bitmap.close();
  }
}

// The gallery's small copy of a photo, as the server makes it
// (server/lib/image_codec.js): 640 pixels on its longer side, a WebP data
// URL (a JPEG where the browser can't make WebP). undefined if it can't be
// made, when the gallery shows the photo itself.
export async function makeThumb(source: Blob | string): Promise<string | undefined> {
  try {
    const drawn = await drawnAtMost(source, 640);
    if (!drawn) return undefined;
    const webp = drawn.canvas.toDataURL('image/webp', 0.75);
    return webp.startsWith('data:image/webp') ? webp : drawn.canvas.toDataURL('image/jpeg', 0.8);
  } catch {
    return undefined;
  }
}

// A photo to keep on a server that keeps them at most maxSide pixels on a
// side (GET /settings keepMaxSide): scaled down here, so less goes over the
// network, as a JPEG, or a PNG where there's transparency. The file as it
// is if it's small enough already, or the browser can't.
export async function fitForKeeping(file: Blob, maxSide: number | null): Promise<Blob> {
  if (!maxSide) return file;
  try {
    const drawn = await drawnAtMost(file, maxSide);
    if (!drawn) return file;
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const smaller = await new Promise<Blob | null>((resolve) =>
      drawn.canvas.toBlob(resolve, type, 0.92),
    );
    return smaller ?? file;
  } catch {
    return file;
  }
}
