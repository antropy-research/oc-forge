// Sunsama's Braindump: free text in, a list of tasks out, one per line (with the Add Task syntax), checked before they
// are added. Organized by the agent you chat with, the notes go to it instead (panel/lib/assistant/ask.ts).
import type { DateKey, Placement, Priority } from '../core/types.ts';
import { parseQuickAdd } from '../plan/quickAdd.ts';

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
