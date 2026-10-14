import { computed, signal } from '@angular/core';
import { Layer } from '../models';

// The filter stack as it was after one edit.
export interface StackState {
  layers: Layer[];
  // The preset look the stack came from, while it hasn't been changed.
  preset: string | null;
}

// One entry in the history: what the edit was, and the stack after it.
export interface HistoryStep {
  label: string;
  state: StackState;
  // Edits with the same key in quick succession (a slider moved with the
  // arrow keys, say) become one step.
  key?: string;
  at: number;
}

// How many steps are kept; the oldest are dropped past this.
export const MAX_STEPS = 100;

// Edits to the same control within this long are merged.
export const MERGE_MS = 1000;

export function sameState(a: StackState, b: StackState): boolean {
  return a.preset === b.preset && JSON.stringify(a.layers) === JSON.stringify(b.layers);
}

// Undo and redo for the filter stack: a list of steps and the one being
// shown. Undoing moves back along the list; a new edit after undoing drops
// the steps that were undone, the way editors usually work.
export class EditHistory {
  private readonly now: () => number;
  readonly steps = signal<HistoryStep[]>([]);
  readonly index = signal(-1);

  readonly canUndo = computed(() => this.index() > 0);
  readonly canRedo = computed(() => this.index() < this.steps().length - 1);
  readonly current = computed(() => this.steps()[this.index()]);

  // Whether the current step is the edit just recorded (not one gone back
  // to), so the next edit of the same control may merge with it.
  private mergeable = false;

  constructor(start: StackState, now: () => number = Date.now) {
    this.now = now;
    this.reset(start);
  }

  // Starts again with just this state.
  reset(state: StackState, label = 'Start'): void {
    this.steps.set([{ label, state, at: this.now() }]);
    this.index.set(0);
    this.mergeable = false;
  }

  // Puts back a saved history (from a draft). Ignored if it doesn't look right.
  restore(steps: HistoryStep[], index: number): boolean {
    if (!Array.isArray(steps) || !steps.length) return false;
    if (!Number.isInteger(index) || index < 0 || index >= steps.length) return false;
    this.steps.set(steps.slice(-MAX_STEPS));
    this.index.set(Math.max(0, index - Math.max(0, steps.length - MAX_STEPS)));
    this.mergeable = false;
    return true;
  }

  // Records an edit. Nothing is recorded if the stack didn't change.
  record(label: string, state: StackState, key?: string): void {
    const current = this.current();
    if (current && sameState(current.state, state)) return;
    const at = this.now();
    const kept = this.steps().slice(0, this.index() + 1);
    const last = kept[kept.length - 1];
    // The same control again, straight after: update that step instead (but
    // never the starting point).
    if (this.mergeable && key && last?.key === key && kept.length > 1 && at - last.at < MERGE_MS) {
      kept[kept.length - 1] = { label, state, key, at };
    } else {
      kept.push({ label, state, key, at });
    }
    const steps = kept.slice(-MAX_STEPS);
    this.steps.set(steps);
    this.index.set(steps.length - 1);
    this.mergeable = true;
  }

  // Changes every step's stack, keeping the steps themselves.
  mapStates(change: (state: StackState) => StackState): void {
    this.steps.update((steps) => steps.map((s) => ({ ...s, state: change(s.state) })));
  }

  undo(): StackState | null {
    return this.canUndo() ? this.jump(this.index() - 1) : null;
  }

  redo(): StackState | null {
    return this.canRedo() ? this.jump(this.index() + 1) : null;
  }

  jump(index: number): StackState | null {
    const step = this.steps()[index];
    if (!step) return null;
    this.index.set(index);
    this.mergeable = false;
    return step.state;
  }
}
