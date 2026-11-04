// A Google Tasks list as the Google Tasks app shows it: open tasks in the
// list's order with their subtasks one level in, a "Completed" section, and
// where a task goes (Google's parent and previous sibling) when it is dragged,
// indented or outdented.
import type { DateKey } from './types.ts';
import { addDays } from './dates.ts';
import { shortDay, weekdayShort } from './gcalendar.ts';
import type { GoogleTaskItem } from './google.ts';

/** "Today", "Tomorrow", "Wed, Oct 28", as Google Tasks labels a date. */
export const dueChip = (due: DateKey, today: DateKey): string => {
  if (due === today) return 'Today';
  if (due === addDays(today, 1)) return 'Tomorrow';
  if (due === addDays(today, -1)) return 'Yesterday';
  const label = `${weekdayShort(due).slice(0, 1)}${weekdayShort(due).slice(1).toLowerCase()}, ${shortDay(due)}`;
  return due.slice(0, 4) === today.slice(0, 4) ? label : `${label}, ${due.slice(0, 4)}`;
};

export interface TaskRow {
  item: GoogleTaskItem;
  depth: 0 | 1;
  /** Open subtasks under it. */
  children: number;
}

/** Where tasks.move puts a task: under `parent` (null: top level), right after `previous` (null: first). */
export interface MoveTarget {
  parent: string | null;
  previous: string | null;
}

const byPosition = (a: GoogleTaskItem, b: GoogleTaskItem): number => a.position.localeCompare(b.position) || a.id.localeCompare(b.id);

/**
 * Open tasks in order: each top-level task followed by its open subtasks.
 * A subtask whose parent is gone or completed has no place among the
 * top-level tasks (its position counts among its old siblings), so it shows
 * after them.
 */
export const openRows = (items: readonly GoogleTaskItem[]): TaskRow[] => {
  const open = items.filter((item) => !item.completed);
  const openIds = new Set(open.map((item) => item.id));
  const children = new Map<string, GoogleTaskItem[]>();
  const top: GoogleTaskItem[] = [];
  const orphans: GoogleTaskItem[] = [];
  for (const item of open) {
    if (item.parent && openIds.has(item.parent)) children.set(item.parent, [...(children.get(item.parent) ?? []), item]);
    else if (item.parent) orphans.push(item);
    else top.push(item);
  }
  const rows: TaskRow[] = [];
  for (const item of [...top.sort(byPosition), ...orphans.sort(byPosition)]) {
    const kids = (children.get(item.id) ?? []).sort(byPosition);
    rows.push({ item, depth: 0, children: kids.length });
    for (const kid of kids) rows.push({ item: kid, depth: 1, children: 0 });
  }
  return rows;
};

/** The "Completed" section: most recently completed first. */
export const completedItems = (items: readonly GoogleTaskItem[]): GoogleTaskItem[] =>
  items.filter((item) => item.completed).sort((a, b) => (b.completedAt ?? b.updated).localeCompare(a.completedAt ?? a.updated) || byPosition(a, b));

/** One heading of Google Tasks' "Sort by date": tasks before today, each later day, or no date. */
export interface DateGroup {
  kind: 'past' | 'day' | 'none';
  date: string | null;
  items: GoogleTaskItem[];
}

/** Open tasks by date, as Google Tasks sorts them: past ones first, then day by day, then the ones without a date. */
export const dateGroups = (items: readonly GoogleTaskItem[], today: string): DateGroup[] => {
  const open = items.filter((item) => !item.completed);
  const past = open.filter((item) => item.due !== null && item.due < today).sort((a, b) => a.due!.localeCompare(b.due!) || byPosition(a, b));
  const days = new Map<string, GoogleTaskItem[]>();
  for (const item of open) if (item.due !== null && item.due >= today) days.set(item.due, [...(days.get(item.due) ?? []), item]);
  const none = open.filter((item) => item.due === null).sort(byPosition);
  return [
    ...(past.length ? [{ kind: 'past' as const, date: null, items: past }] : []),
    ...[...days.keys()].sort().map((date) => ({ kind: 'day' as const, date, items: days.get(date)!.sort(byPosition) })),
    ...(none.length ? [{ kind: 'none' as const, date: null, items: none }] : []),
  ];
};

/**
 * Open tasks by deadline, as Google Tasks' "Sort by Deadline": the ones whose
 * deadline has passed first ("Past"), then deadline by deadline, then the ones
 * without one. Deadlines are the Planner's (`deadlineOf`), as Google Tasks'
 * API has none.
 */
export const deadlineSections = (items: readonly GoogleTaskItem[], today: string, deadlineOf: (item: GoogleTaskItem) => string | null): DateGroup[] => {
  const open = items.filter((item) => !item.completed);
  const byDeadline = (a: GoogleTaskItem, b: GoogleTaskItem) => deadlineOf(a)!.localeCompare(deadlineOf(b)!) || byPosition(a, b);
  const past = open.filter((item) => (deadlineOf(item) ?? today) < today).sort(byDeadline);
  const days = new Map<string, GoogleTaskItem[]>();
  for (const item of open) {
    const deadline = deadlineOf(item);
    if (deadline !== null && deadline >= today) days.set(deadline, [...(days.get(deadline) ?? []), item]);
  }
  const none = open.filter((item) => deadlineOf(item) === null).sort(byPosition);
  return [
    ...(past.length ? [{ kind: 'past' as const, date: null, items: past }] : []),
    ...[...days.keys()].sort().map((date) => ({ kind: 'day' as const, date, items: days.get(date)!.sort(byPosition) })),
    ...(none.length ? [{ kind: 'none' as const, date: null, items: none }] : []),
  ];
};

/** Open tasks by title, as Google Tasks' "Sort by Title": A to Z, numbers in order, subtasks among them. */
export const byTitle = (items: readonly GoogleTaskItem[]): GoogleTaskItem[] =>
  items.filter((item) => !item.completed).sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }) || byPosition(a, b));

/** The open subtasks of a task, in order. */
export const subtasksOf = (items: readonly GoogleTaskItem[], id: string): GoogleTaskItem[] => items.filter((item) => item.parent === id && !item.completed).sort(byPosition);

const rowIndex = (rows: readonly TaskRow[], id: string): number => rows.findIndex((row) => row.item.id === id);

/**
 * Where a dragged task lands when dropped before `rows[index]` of the list
 * shown without it (and without its subtasks, which travel with it). With
 * `asSubtask` (dragged to the right, as in Google Tasks) it goes under the
 * task above; a task that has subtasks stays at the top level. So does a
 * repeating task, and one dropped under a repeating task (`repeats`): as in
 * Google Tasks, a repeating task has no subtasks and is none.
 */
export const dropTarget = (allRows: readonly TaskRow[], draggedId: string, index: number, asSubtask: boolean, repeats: (id: string) => boolean = () => false): MoveTarget => {
  const rows = allRows.filter((row) => row.item.id !== draggedId && row.item.parent !== draggedId);
  const dragged = allRows.find((row) => row.item.id === draggedId);
  const canNest = (dragged?.children ?? 0) === 0 && !repeats(draggedId);
  const at = Math.max(0, Math.min(index, rows.length));
  const above = rows[at - 1];
  const below = rows[at];
  const parent = above ? (above.depth === 1 ? above.item.parent : above.item.id) : null;
  if (canNest && above && parent && !repeats(parent) && (asSubtask || below?.depth === 1)) {
    return above.depth === 1 ? { parent, previous: above.item.id } : { parent, previous: null };
  }
  // At the top level: after the nearest top-level task above.
  for (let scan = at - 1; scan >= 0; scan--) if (rows[scan]!.depth === 0) return { parent: null, previous: rows[scan]!.item.id };
  return { parent: null, previous: null };
};

/** Make a task a subtask of the task above it (Google Tasks' "Indent"); null when it cannot be. */
export const indentTarget = (rows: readonly TaskRow[], id: string): MoveTarget | null => {
  const at = rowIndex(rows, id);
  const row = rows[at];
  const above = rows[at - 1];
  if (!row || row.depth !== 0 || row.children > 0 || !above) return null;
  return above.depth === 0 ? { parent: above.item.id, previous: null } : { parent: above.item.parent, previous: above.item.id };
};

/** Make a subtask a task again, right after its parent ("Unindent"); null when it is not a subtask. */
export const outdentTarget = (rows: readonly TaskRow[], id: string): MoveTarget | null => {
  const row = rows[rowIndex(rows, id)];
  if (!row || row.depth !== 1 || !row.item.parent) return null;
  return { parent: null, previous: row.item.parent };
};

const siblings = (rows: readonly TaskRow[], row: TaskRow): TaskRow[] => rows.filter((other) => other.depth === row.depth && (row.depth === 0 || other.item.parent === row.item.parent));

/** One place up among its siblings; null when it is first. */
export const moveUpTarget = (rows: readonly TaskRow[], id: string): MoveTarget | null => {
  const row = rows[rowIndex(rows, id)];
  if (!row) return null;
  const list = siblings(rows, row);
  const at = list.indexOf(row);
  if (at < 1) return null;
  return { parent: row.depth === 1 ? row.item.parent : null, previous: list[at - 2]?.item.id ?? null };
};

/** One place down among its siblings; null when it is last. */
export const moveDownTarget = (rows: readonly TaskRow[], id: string): MoveTarget | null => {
  const row = rows[rowIndex(rows, id)];
  if (!row) return null;
  const list = siblings(rows, row);
  const at = list.indexOf(row);
  if (at < 0 || at >= list.length - 1) return null;
  return { parent: row.depth === 1 ? row.item.parent : null, previous: list[at + 1]!.item.id };
};

/** First among its siblings (Google Tasks' "Move to top", Ctrl/⌘+Shift+Up); null when it is first already. */
export const moveTopTarget = (rows: readonly TaskRow[], id: string): MoveTarget | null => {
  const row = rows[rowIndex(rows, id)];
  if (!row || siblings(rows, row).indexOf(row) < 1) return null;
  return { parent: row.depth === 1 ? row.item.parent : null, previous: null };
};

/** Last among its siblings (Google Tasks' "Move to bottom", Ctrl/⌘+Shift+Down); null when it is last already. */
export const moveBottomTarget = (rows: readonly TaskRow[], id: string): MoveTarget | null => {
  const row = rows[rowIndex(rows, id)];
  if (!row) return null;
  const list = siblings(rows, row);
  const at = list.indexOf(row);
  if (at < 0 || at >= list.length - 1) return null;
  return { parent: row.depth === 1 ? row.item.parent : null, previous: list.at(-1)!.item.id };
};

/** A position string that sorts between two others (Google's are 20-digit numbers); for showing a move before Google answers. */
export const positionBetween = (before: string | undefined, after: string | undefined): string => {
  const digits = (value: string | undefined) => (value && /^\d+$/.test(value) ? BigInt(value) : null);
  const low = before === undefined ? null : digits(before);
  const high = after === undefined ? null : digits(after);
  const width = Math.max(before?.length ?? 0, after?.length ?? 0, 20);
  const pad = (value: bigint) => value.toString().padStart(width, '0');
  if (before === undefined && after === undefined) return pad(0n);
  if (before === undefined) return high !== null && high > 0n ? pad(high - 1n) : `${after!.slice(0, -1)}`;
  if (after === undefined) return low !== null ? pad(low + 1n) : `${before}5`;
  if (low !== null && high !== null && high - low > 1n) return pad((low + high) / 2n);
  return `${before}5`;
};

/** The list with `id` moved to `target`, as it will look once Google has moved it. */
export const applyMove = (items: readonly GoogleTaskItem[], id: string, target: MoveTarget): GoogleTaskItem[] => {
  const moving = items.find((item) => item.id === id);
  if (!moving) return [...items];
  const peers = items.filter((item) => item.id !== id && !item.completed && (item.parent ?? null) === target.parent).sort(byPosition);
  const at = target.previous ? peers.findIndex((item) => item.id === target.previous) + 1 : 0;
  const position = positionBetween(peers[at - 1]?.position, peers[at]?.position);
  return items.map((item) => (item.id === id ? { ...item, parent: target.parent, position } : item));
};
