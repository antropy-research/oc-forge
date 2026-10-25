// Sunsama's Braindump: free text in, a list of tasks out. Lines work without a
// model (with the Add Task syntax); a model answer is read strictly.
import { BACKLOG_BUCKETS, type BacklogBucket, type DateKey, type Placement, type Priority } from './types.ts';
import { addDays } from './dates.ts';
import { parseQuickAdd } from './quickAdd.ts';

export interface DumpItem {
  title: string;
  plannedMinutes: number | null;
  placement: Placement;
  /** Channel name as written; resolved (or created) when the items are added. */
  channel: string | null;
  priority: Priority | null;
}

const MAX_ITEMS = 100;
const BULLET = /^\s*(?:[-*+•·]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|\[[ xX]\]\s+)/;

/** One task per non-empty line; bullets and numbers are dropped, `~30m @tomorrow #work !high` honored. */
export const parseBraindump = (text: string, today: DateKey, weekStartsOn: 0 | 1, fallback: Placement): DumpItem[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.replace(BULLET, '').trim())
    .filter(Boolean)
    .map((line) => {
      const parsed = parseQuickAdd(line, today, weekStartsOn);
      return { title: (parsed.title || line).slice(0, 500), plannedMinutes: parsed.plannedMinutes, placement: parsed.placement ?? fallback, channel: parsed.channel, priority: parsed.priority };
    })
    .slice(0, MAX_ITEMS);

const BUCKET_IDS = new Set<string>(BACKLOG_BUCKETS.map((bucket) => bucket.id));
const PRIORITIES = new Set(['urgent', 'high', 'medium', 'low']);

export const braindumpSystem = (channels: readonly string[]): string =>
  [
    "You turn a person's brain dump into a short list of concrete tasks for their planner.",
    'Answer with only a JSON array. Each item is an object:',
    '{"title": an imperative task title under 80 characters, "minutes": a realistic estimate in minutes or null,',
    '"when": one of "today", "tomorrow", "next-weeks", "next-month", "next-quarter", "next-year", "someday",',
    `"channel": one of ${JSON.stringify(channels)} or null, "priority": "urgent", "high", "medium", "low" or null}.`,
    'Keep the language of the brain dump. Do not invent work that is not in the text. Merge duplicates. No commentary.',
  ].join('\n');

/** Items from a model answer; null when it is not a usable JSON array. */
export const readBraindumpAnswer = (answer: string, today: DateKey, fallback: Placement, channels: readonly string[]): DumpItem[] | null => {
  const match = /\[[\s\S]*\]/.exec(answer);
  if (!match) return null;
  let data: unknown;
  try {
    data = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const known = new Map(channels.map((name) => [name.toLowerCase(), name]));
  const items = data.flatMap((entry): DumpItem[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const value = entry as Record<string, unknown>;
    if (typeof value.title !== 'string' || !value.title.trim()) return [];
    const minutes = typeof value.minutes === 'number' && Number.isFinite(value.minutes) && value.minutes > 0 && value.minutes <= 600 ? Math.round(value.minutes) : null;
    const when = typeof value.when === 'string' ? value.when : '';
    const placement: Placement =
      when === 'today' ? { kind: 'day', date: today } : when === 'tomorrow' ? { kind: 'day', date: addDays(today, 1) } : BUCKET_IDS.has(when) ? { kind: 'backlog', bucket: when as BacklogBucket } : fallback;
    const channel = typeof value.channel === 'string' ? known.get(value.channel.toLowerCase().replace(/^#/, '')) ?? null : null;
    const priority = typeof value.priority === 'string' && PRIORITIES.has(value.priority) ? (value.priority as Priority) : null;
    return [{ title: value.title.trim().slice(0, 500), plannedMinutes: minutes, placement, channel, priority }];
  });
  return items.length ? items.slice(0, MAX_ITEMS) : null;
};
