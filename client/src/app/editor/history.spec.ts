import { EditHistory, MAX_STEPS, MERGE_MS, StackState } from './history';

const state = (radius: number, preset: string | null = null): StackState => ({
  layers: [{ tOption: 'blur', params: { radius }, amount: 100, blend: 'normal' }],
  preset,
});

describe('EditHistory', () => {
  let time: number;
  let history: EditHistory;

  beforeEach(() => {
    time = 0;
    history = new EditHistory(state(1), () => time);
  });

  it('undoes and redoes edits', () => {
    expect(history.canUndo()).toBe(false);
    history.record('Radius 2', state(2));
    history.record('Radius 3', state(3));
    expect(history.steps().map((s) => s.label)).toEqual(['Start', 'Radius 2', 'Radius 3']);
    expect(history.undo()).toEqual(state(2));
    expect(history.undo()).toEqual(state(1));
    expect(history.undo()).toBeNull();
    expect(history.canRedo()).toBe(true);
    expect(history.redo()).toEqual(state(2));
    expect(history.current()?.label).toBe('Radius 2');
  });

  it('drops the undone steps when something new is done', () => {
    history.record('Radius 2', state(2));
    history.record('Radius 3', state(3));
    history.undo();
    history.undo();
    history.record('Radius 9', state(9));
    expect(history.steps().map((s) => s.label)).toEqual(['Start', 'Radius 9']);
    expect(history.canRedo()).toBe(false);
  });

  it("records nothing when the stack didn't change", () => {
    history.record('Same', state(1));
    expect(history.steps().length).toBe(1);
    // Picking a preset is a change, even with the same layers.
    history.record('Look', state(1, 'soft'));
    expect(history.steps().length).toBe(2);
  });

  it('merges quick edits of the same control', () => {
    history.record('Radius 2', state(2), 'radius');
    time += MERGE_MS / 2;
    history.record('Radius 3', state(3), 'radius');
    time += MERGE_MS / 2;
    history.record('Radius 4', state(4), 'radius');
    expect(history.steps().map((s) => s.label)).toEqual(['Start', 'Radius 4']);
    // Too long after, or another control: a new step.
    time += MERGE_MS * 2;
    history.record('Radius 5', state(5), 'radius');
    history.record('Look', state(5, 'soft'), 'look');
    expect(history.steps().length).toBe(4);
  });

  it("doesn't merge into a step that was gone back to", () => {
    history.record('Radius 2', state(2), 'radius');
    history.record('Radius 3', state(3), 'other');
    history.undo();
    history.record('Radius 7', state(7), 'radius');
    expect(history.steps().map((s) => s.label)).toEqual(['Start', 'Radius 2', 'Radius 7']);
  });

  it('jumps to any step, and keeps at most MAX_STEPS', () => {
    for (let i = 2; i < MAX_STEPS + 20; i++) history.record('Radius ' + i, state(i));
    expect(history.steps().length).toBe(MAX_STEPS);
    // The start and the first edits have gone.
    expect(history.steps()[0].label).toBe('Radius 20');
    expect(history.jump(0)).toEqual(state(20));
    expect(history.jump(MAX_STEPS)).toBeNull();
  });

  it('restores a saved history, refusing one that is broken', () => {
    const saved = [
      { label: 'Start', state: state(1), at: 0 },
      { label: 'Radius 4', state: state(4), at: 1 },
    ];
    expect(history.restore(saved, 5)).toBe(false);
    expect(history.restore([], 0)).toBe(false);
    expect(history.restore(saved, 0)).toBe(true);
    expect(history.current()?.label).toBe('Start');
    expect(history.canRedo()).toBe(true);
  });
});
