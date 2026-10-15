import { Component, computed, input, output, signal } from '@angular/core';
import type { DeviceResult } from '../editor/device-transform';

// A photo just filtered on this device, before it's kept: how fast that
// was, with Save and Share straight away, and Keep (in the gallery, which
// on the hosted demo holds a few photos) or Discard.
export interface MadeOnDevice extends DeviceResult {
  // An object URL for the file, which the card's owner revokes.
  url: string;
  label: string;
  fileName: string;
}

// "12.2 MP", from a width and height.
export const megapixels = (w: number, h: number) => (w * h) / 1e6;

// The card's summary of how it was made, e.g. "12.2 MP, made on Apple GPU
// in 1.8 s (6.8 MP/s)".
export function madeSummary(r: DeviceResult): string {
  const mp = megapixels(r.width, r.height);
  const seconds = r.timings.total / 1000;
  return (
    mp.toFixed(1) +
    ' MP, made on ' +
    r.device +
    ' in ' +
    seconds.toFixed(1) +
    ' s (' +
    (mp / Math.max(seconds, 0.001)).toFixed(1) +
    ' MP/s)'
  );
}

// Where the time went, e.g. "decode 0.3 s · filters 1.1 s · encode 0.4 s".
export function timingParts(r: DeviceResult): string {
  const t = r.timings;
  const s = (ms: number) => (ms / 1000).toFixed(ms < 100 ? 2 : 1) + ' s';
  return [
    'decode ' + s(t.decode),
    'to the GPU ' + s(t.upload),
    'filters ' + s(t.filters),
    'back ' + s(t.readback),
    'encode ' + s(t.encode),
  ].join(' · ');
}

@Component({
  selector: 'of-result-card',
  templateUrl: './result-card.html',
  styleUrl: './result-card.scss',
})
export class ResultCard {
  readonly result = input.required<MadeOnDevice>();
  // "Keep in gallery (2 of 5)" and the like, and whether there's room.
  readonly keepText = input('Keep in gallery');
  readonly canKeep = input(true);
  readonly keeping = input(false);
  readonly keep = output<void>();
  readonly discard = output<void>();

  readonly summary = computed(() => madeSummary(this.result()));
  readonly parts = computed(() => timingParts(this.result()));
  readonly shareError = signal<string | null>(null);
  readonly canShare =
    typeof navigator !== 'undefined' && 'share' in navigator && 'canShare' in navigator;

  async share(): Promise<void> {
    this.shareError.set(null);
    const r = this.result();
    try {
      const file = new File([r.file], r.fileName, { type: r.file.type });
      if (!navigator.canShare({ files: [file] })) {
        this.shareError.set("This browser can't share images; use Save instead.");
        return;
      }
      await navigator.share({ files: [file], title: r.label });
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') this.shareError.set('Could not share the photo.');
    }
  }
}
