import { Directive, ElementRef, effect, inject, input } from '@angular/core';
import type { GpuEngine, StackLayer } from '../../gpu';
import { PreviewPhoto } from './preview-engine';

// Small previews of whole stacks (the preset looks) on the user's photo,
// rendered one after another on the GPU and read back as ImageData.
// Painterly filters run at a capped size rather than the server's working
// size: a little less faithful, much quicker, and it doesn't show at
// thumbnail size. `stale` is asked between stacks: once it says the photo or
// presets have changed, the rest aren't rendered.
const MAX_WORKING_SIDE = 480;
export async function renderThumbnails(
  engine: GpuEngine,
  photo: PreviewPhoto,
  stacks: { key: string; layers: StackLayer[] }[],
  blendModes: readonly string[],
  stale: () => boolean = () => false,
): Promise<Map<string, ImageData>> {
  const out = new Map<string, ImageData>();
  // Loaded already, with the engine.
  const { StackRenderer } = await import('../../gpu');
  const renderer = new StackRenderer(engine, blendModes, MAX_WORKING_SIDE);
  try {
    renderer.setSource(photo.rgba, photo.width, photo.height, photo.fullWidth, photo.fullHeight);
    for (const { key, layers } of stacks) {
      if (stale()) break;
      const result = renderer.render(layers);
      if (!('image' in result)) continue;
      const pixels = await engine.readPixels(result.image);
      out.set(key, new ImageData(new Uint8ClampedArray(pixels), photo.width, photo.height));
      // Each stack is separate; nothing to reuse from the last one.
      renderer.clearCache();
    }
  } finally {
    renderer.destroy();
  }
  return out;
}

// Draws ImageData into a <canvas>, at the image's own size (CSS scales it).
@Directive({ selector: 'canvas[ofImageData]' })
export class ImageDataCanvas {
  private readonly el = inject<ElementRef<HTMLCanvasElement>>(ElementRef);
  readonly ofImageData = input<ImageData | undefined>();

  constructor() {
    effect(() => {
      const data = this.ofImageData();
      const canvas = this.el.nativeElement;
      if (!data) {
        canvas.width = 0;
        canvas.height = 0;
        return;
      }
      canvas.width = data.width;
      canvas.height = data.height;
      canvas.getContext('2d')?.putImageData(data, 0, 0);
    });
  }
}
