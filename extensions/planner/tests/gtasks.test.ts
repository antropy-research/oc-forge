import { describe, expect, test } from 'bun:test';
import { applyMove, completedItems, dropTarget, indentTarget, moveDownTarget, moveUpTarget, openRows, outdentTarget, positionBetween, subtasksOf } from '../src/domain/gtasks.ts';
import type { GoogleTaskItem } from '../src/domain/google.ts';

const task = (id: string, position: number, extra: Partial<GoogleTaskItem> = {}): GoogleTaskItem => ({
  account: 'me@x.com', listId: 'L1', id, title: id, notes: '', due: null, completed: false, parent: null, position: String(position).padStart(20, '0'), url: `https://tasks.google.com/task/${id}`, updated: '2026-10-26T10:00:00Z', ...extra,
});
/** A list as Google returns it: B has two subtasks, D is completed, E is a subtask whose parent is completed. */
const list = [
  task('C', 3),
  task('A', 1),
  task('B', 2),
  task('B2', 2, { parent: 'B' }),
  task('B1', 1, { parent: 'B' }),
  task('D', 4, { completed: true, completedAt: '2026-10-25T10:00:00Z' }),
  task('E', 1, { parent: 'D' }),
  task('F', 5, { completed: true, completedAt: '2026-10-26T09:00:00Z' }),
];
const shape = (rows: ReturnType<typeof openRows>) => rows.map((row) => `${'  '.repeat(row.depth)}${row.item.id}`);

describe('a Google Tasks list as the app shows it', () => {
  test('open tasks in order with their subtasks, then "Completed", latest first', () => {
    expect(shape(openRows(list))).toEqual(['A', 'B', '  B1', '  B2', 'C', 'E']);
    expect(openRows(list).find((row) => row.item.id === 'B')!.children).toBe(2);
    expect(completedItems(list).map((item) => item.id)).toEqual(['F', 'D']);
    expect(subtasksOf(list, 'B').map((item) => item.id)).toEqual(['B1', 'B2']);
  });
});

describe('where a task goes', () => {
  const rows = openRows(list);
  test('dropped between tasks, under the task above when dragged right, between subtasks', () => {
    // A dragged below C: top level after C.
    expect(dropTarget(rows, 'A', 4, false)).toEqual({ parent: null, previous: 'C' });
    // C dragged to the very top.
    expect(dropTarget(rows, 'C', 0, false)).toEqual({ parent: null, previous: null });
    // C dragged right just below A: a subtask of A.
    expect(dropTarget(rows, 'C', 1, true)).toEqual({ parent: 'A', previous: null });
    // C dropped between B1 and B2: between those subtasks.
    expect(dropTarget(rows, 'C', 3, false)).toEqual({ parent: 'B', previous: 'B1' });
    // C dropped right after B2 without dragging right: top level, after B.
    expect(dropTarget(rows, 'C', 4, false)).toEqual({ parent: null, previous: 'B' });
    // B has subtasks, so it stays at the top level wherever it is dropped.
    expect(dropTarget(rows, 'B', 1, true)).toEqual({ parent: null, previous: 'A' });
  });
  test('indent under the task above, outdent after the parent, up and down among siblings', () => {
    expect(indentTarget(rows, 'C')).toEqual({ parent: 'B', previous: 'B2' });
    expect(indentTarget(rows, 'B')).toBeNull();
    expect(indentTarget(rows, 'A')).toBeNull();
    expect(outdentTarget(rows, 'B1')).toEqual({ parent: null, previous: 'B' });
    expect(outdentTarget(rows, 'A')).toBeNull();
    expect(moveUpTarget(rows, 'C')).toEqual({ parent: null, previous: 'A' });
    expect(moveUpTarget(rows, 'B')).toEqual({ parent: null, previous: null });
    expect(moveUpTarget(rows, 'A')).toBeNull();
    expect(moveDownTarget(rows, 'B1')).toEqual({ parent: 'B', previous: 'B2' });
    expect(moveDownTarget(rows, 'B2')).toBeNull();
  });
  test('a move shows at once, in the right place, before Google answers', () => {
    expect(shape(openRows(applyMove(list, 'C', { parent: null, previous: null })))).toEqual(['C', 'A', 'B', '  B1', '  B2', 'E']);
    expect(shape(openRows(applyMove(list, 'C', { parent: 'B', previous: 'B1' })))).toEqual(['A', 'B', '  B1', '  C', '  B2', 'E']);
    expect(shape(openRows(applyMove(list, 'B1', { parent: null, previous: 'B' })))).toEqual(['A', 'B', '  B2', 'B1', 'C', 'E']);
  });
  test('positions between two others, as Google sorts them', () => {
    const at = (n: number) => String(n).padStart(20, '0');
    expect(positionBetween(at(2), at(10))).toBe(at(6));
    expect(positionBetween(at(2), at(3)) > at(2) && positionBetween(at(2), at(3)) < at(3)).toBe(true);
    expect(positionBetween(undefined, at(5))).toBe(at(4));
    expect(positionBetween(at(5), undefined)).toBe(at(6));
    expect(positionBetween(undefined, undefined)).toBe(at(0));
  });
});
