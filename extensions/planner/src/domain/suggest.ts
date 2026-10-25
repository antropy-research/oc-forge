// Planned time and channel from similar past tasks, the way Sunsama suggests
// estimates "from your task history". Deterministic: no model involved.
import type { PlannerState } from './types.ts';
import { actualMinutes } from './selectors.ts';

const STOP_WORDS = new Set(['the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'in', 'on', 'with', 'at', 'by', 'from', 'my', 'your', 'this', 'that', 'is', 'be', 'do', 'up', 'it']);
const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;

/** Words of a title: Latin words of two or more letters, CJK runs as character bigrams. */
export const titleTokens = (title: string): Set<string> => {
  const tokens = new Set<string>();
  for (const word of title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (CJK.test(word)) {
      const chars = [...word];
      if (chars.length === 1) tokens.add(chars[0]!);
      for (let index = 0; index < chars.length - 1; index++) tokens.add(chars[index]! + chars[index + 1]!);
    } else if (word.length >= 2 && !STOP_WORDS.has(word) && !/^\d+$/.test(word)) {
      tokens.add(word);
    }
  }
  return tokens;
};

const similarity = (a: Set<string>, b: Set<string>): number => {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared === 0 ? 0 : shared / (a.size + b.size - shared);
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((x, y) => x - y);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

export interface Suggestion {
  minutes: number | null;
  channelId: string | null;
  /** How many similar tasks it came from. */
  basis: number;
}

const THRESHOLD = 0.5;
const NEIGHBOURS = 7;

/** A suggestion for a task titled `title`, or null when nothing similar is known. */
export const suggestFor = (state: PlannerState, title: string, excludeTaskId?: string): Suggestion | null => {
  const target = titleTokens(title);
  if (target.size === 0) return null;
  const scored: { score: number; updatedAt: string; minutes: number; channelId: string | null }[] = [];
  for (const task of Object.values(state.tasks)) {
    if (task.id === excludeTaskId || task.deletedAt) continue;
    const score = similarity(target, titleTokens(task.title));
    if (score < THRESHOLD) continue;
    const tracked = task.completedAt ? actualMinutes(state, task) : 0;
    scored.push({ score, updatedAt: task.updatedAt, minutes: tracked > 0 ? tracked : task.plannedMinutes ?? 0, channelId: task.channelId });
  }
  if (scored.length === 0) return null;
  const top = scored.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt)).slice(0, NEIGHBOURS);
  const known = top.map((item) => item.minutes).filter((minutes) => minutes > 0);
  const minutes = known.length ? Math.max(5, Math.round(median(known) / 5) * 5) : null;
  const counts = new Map<string, number>();
  for (const item of top) {
    const channel = item.channelId ? state.channels[item.channelId] : undefined;
    if (channel && !channel.deletedAt) counts.set(channel.id, (counts.get(channel.id) ?? 0) + 1);
  }
  const channelId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return minutes === null && channelId === null ? null : { minutes, channelId, basis: top.length };
};
