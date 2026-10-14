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

// The first image file in a drop or paste, if any.
export function imageFrom(items: DataTransfer | null): File | null {
  if (!items) return null;
  for (const file of Array.from(items.files)) {
    if (file.type.startsWith('image/')) return file;
  }
  return null;
}
