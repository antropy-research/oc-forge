// What Google Tasks' "Print list" prints (List options → Print list, or
// Ctrl/⌘+P; https://support.google.com/tasks/answer/12298851): the list's
// title, its open tasks in the list's order (as it is sorted), each subtask
// under its task, with what a task shows (its date, with the time the Planner
// keeps, its repeat, deadline, star and details), and its completed tasks when
// the Completed section is open ("To print your complete tasks, at the bottom
// of the list, click Completed").
import type { DateKey, GoogleTaskKept } from './types.ts';
import type { GoogleTaskItem } from './google.ts';
import { keptTimeLabel } from './gtaskKept.ts';
import { describeRecurrence } from './rrule.ts';
import { byTitle, completedItems, dateGroups, deadlineSections, dueChip, openRows } from './gtasks.ts';

/** Google Tasks' "Sort by", as a list is sorted when it prints; 'shown': in the order given, as Starred shows them. */
export type ListSort = 'mine' | 'date' | 'deadline' | 'starred' | 'title' | 'shown';

/** One task as it prints. */
export interface PrintedTask {
  id: string;
  title: string;
  /** 1: a subtask, printed under its task. */
  depth: 0 | 1;
  /** Its details, whole. */
  notes: string;
  /** "Today, 2 – 3 PM"; null without a date. */
  due: string | null;
  /** An open task whose date has passed. */
  overdue: boolean;
  /** "Repeats Daily"; null when it does not repeat. */
  repeat: string | null;
  /** "Deadline Fri, Oct 31"; null without one. */
  deadline: string | null;
  starred: boolean;
  /** "Completed: Yesterday", for a completed task. */
  completed: string | null;
  /** Its list, where tasks of several lists print together (Starred). */
  list: string | null;
}

/** A task list as it prints. */
export interface PrintedList {
  title: string;
  /** Its account, when several are connected (the list's heading says it too). */
  account: string | null;
  /** The open tasks; under headings when the list is sorted by date or deadline ("Past", a day, "No date"). */
  sections: { heading: string | null; tasks: PrintedTask[] }[];
  /** The completed tasks, the latest first, when the Completed section is open; null when it is closed. */
  completed: PrintedTask[] | null;
  /** How many completed tasks the list has, printed or not. */
  completedCount: number;
  /** Google Tasks has more of this list than the Planner reads at once. */
  partial: boolean;
}

export interface ListToPrint {
  title: string;
  account: string | null;
  items: readonly GoogleTaskItem[];
  /** What the Planner keeps for a task (time, deadline, repeat, star). */
  kept: (item: GoogleTaskItem) => GoogleTaskKept | null;
  sort: ListSort;
  today: DateKey;
  zone: string;
  /** The Completed section is open. */
  showCompleted: boolean;
  /** The Planner read the whole list. */
  complete: boolean;
  /** Each task's list, where tasks of several lists print together (Starred). */
  listOf?: (item: GoogleTaskItem) => string;
}

/** What a list prints, as the Tasks view shows it now. */
export const printedList = (list: ListToPrint): PrintedList => {
  const { items, kept, today } = list;
  const task = (item: GoogleTaskItem, depth: 0 | 1 = 0): PrintedTask => {
    const own = kept(item);
    const time = keptTimeLabel(own);
    const deadline = own?.deadline ?? null;
    return {
      id: item.id,
      title: item.title,
      depth,
      notes: item.notes,
      due: item.due ? `${dueChip(item.due, today)}${time ? `, ${time}` : ''}` : null,
      overdue: Boolean(item.due && item.due < today && !item.completed),
      repeat: own?.repeat && item.due ? `Repeats ${describeRecurrence([own.repeat.rule], item.due, list.zone)}` : null,
      deadline: deadline ? `Deadline ${dueChip(deadline, today)}` : null,
      starred: Boolean(own?.starredAt),
      completed: item.completed ? `Completed: ${item.completedAt ? dueChip(item.completedAt.slice(0, 10), today) : 'yes'}` : null,
      list: list.listOf?.(item) || null,
    };
  };
  const rows = openRows(items);
  let sections: PrintedList['sections'];
  if (list.sort === 'date' || list.sort === 'deadline') {
    const groups = list.sort === 'date' ? dateGroups(items, today) : deadlineSections(items, today, (item) => kept(item)?.deadline ?? null);
    sections = groups.map((group) => ({
      heading: group.kind === 'past' ? 'Past' : group.kind === 'none' ? (list.sort === 'date' ? 'No date' : 'No deadline') : dueChip(group.date!, today),
      tasks: group.items.map((item) => task(item)),
    }));
  } else if (list.sort === 'starred') {
    // "Starred recently": the starred tasks first, the newest star first, then the rest in the list's order.
    const starred = rows.map((row) => row.item).sort((a, b) => (kept(b)?.starredAt ?? '').localeCompare(kept(a)?.starredAt ?? ''));
    sections = [{ heading: null, tasks: starred.map((item) => task(item)) }];
  } else if (list.sort === 'title') sections = [{ heading: null, tasks: byTitle(items).map((item) => task(item)) }];
  else if (list.sort === 'shown') sections = [{ heading: null, tasks: items.filter((item) => !item.completed).map((item) => task(item)) }];
  else sections = [{ heading: null, tasks: rows.map((row) => task(row.item, row.depth)) }];
  const done = completedItems(items);
  return {
    title: list.title,
    account: list.account,
    sections: sections.filter((section) => section.tasks.length),
    completed: list.showCompleted ? done.map((item) => task(item)) : null,
    completedCount: done.length,
    partial: !list.complete,
  };
};
