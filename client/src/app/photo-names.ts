import { Photo } from './models';

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/tiff': 'tif',
};

// A file name for saving a photo, like omnifilter-sepia-vignette-1a2b3c.jpg.
export function downloadName(
  label: string,
  photo: Pick<Photo, '_id' | 'mime' | 'file' | 'content'>,
): string {
  const type =
    photo.mime ?? photo.file?.type ?? /^data:([^;,]+)/.exec(photo.content ?? '')?.[1] ?? '';
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return (
    'omnifilter-' +
    (slug || 'photo') +
    '-' +
    photo._id.slice(-6) +
    '.' +
    (EXTENSIONS[type] ?? 'img')
  );
}
