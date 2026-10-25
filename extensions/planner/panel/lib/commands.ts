// Command builders shared by the views.
import type { EventBody } from '../../src/domain/events.ts';
import type { QuickAdd } from '../../src/domain/quickAdd.ts';
import { channelByName, edgePosition, liveChannels } from '../../src/domain/selectors.ts';
import { suggestFor } from '../../src/domain/suggest.ts';
import { newId } from '../../src/domain/ids.ts';
import { CHANNEL_COLORS, type DateKey, type Placement, type PlannerState } from '../../src/domain/types.ts';
import { objectiveByText, weekStartOf } from '../../src/domain/rituals.ts';

/** The channel id for `name`, creating the channel in the same batch when it is new. */
export const ensureChannel = (state: PlannerState, name: string, bodies: EventBody[]): string => {
  const existing = channelByName(state, name);
  if (existing) return existing.id;
  const id = newId();
  const color = CHANNEL_COLORS[liveChannels(state).length % CHANNEL_COLORS.length]!;
  bodies.push({ type: 'channel.created', channel: { id, name, color, context: 'work' } });
  return id;
};

export interface CreateOptions {
  edge?: 'top' | 'bottom';
  today?: DateKey;
  folderId?: string | null;
}

/**
 * Commands for parsed Add Task lines. A line's `@` wins over the list it was
 * typed in; new channels are created once per batch; tasks in the same list
 * get consecutive positions; with history suggestions on, empty planned time
 * and channel are filled from similar past tasks.
 */
export const createManyTaskCommands = (state: PlannerState, inputs: readonly QuickAdd[], fallback: Placement, options: CreateOptions = {}): EventBody[] => {
  const bodies: EventBody[] = [];
  const newChannels = new Map<string, string>();
  const next = new Map<string, number>();
  const edge = options.edge ?? 'bottom';
  const positionFor = (placement: Placement): number => {
    const key = placement.kind === 'day' ? `d:${placement.date}` : `b:${placement.bucket}`;
    const position = next.get(key) ?? edgePosition(state, placement, edge);
    // At the top, later items stay below earlier ones and above the old first task (1024 away).
    next.set(key, edge === 'top' ? position + 1 : position + 1024);
    return position;
  };
  const channelFor = (name: string): string => {
    const existing = channelByName(state, name);
    if (existing) return existing.id;
    const key = name.toLowerCase();
    const known = newChannels.get(key);
    if (known) return known;
    const id = newId();
    const color = CHANNEL_COLORS[(liveChannels(state).length + newChannels.size) % CHANNEL_COLORS.length]!;
    bodies.push({ type: 'channel.created', channel: { id, name, color, context: 'work' } });
    newChannels.set(key, id);
    return id;
  };
  for (const input of inputs) {
    const placement = input.placement ?? fallback;
    // `$name` aligns to one of the week's objectives; an unknown name stays in the title.
    const week = weekStartOf(state, placement.kind === 'day' ? placement.date : options.today ?? new Date().toISOString().slice(0, 10));
    const objective = input.objective ? objectiveByText(state, week, input.objective) : null;
    const title = input.objective && !objective ? `${input.title} $${input.objective}` : input.title;
    const suggestion = state.settings.suggestFromHistory && (input.plannedMinutes === null || !input.channel) ? suggestFor(state, title) : null;
    const channelId = input.channel ? channelFor(input.channel) : suggestion?.channelId ?? null;
    bodies.push({
      type: 'task.created',
      task: {
        id: newId(),
        title,
        plannedMinutes: input.plannedMinutes ?? suggestion?.minutes ?? null,
        priority: input.priority,
        placement,
        position: positionFor(placement),
        channelId,
        objectiveId: objective?.id ?? null,
        ...(options.folderId ? { folderId: options.folderId } : {}),
      },
    });
  }
  return bodies;
};

/** Commands for one parsed Add Task line. */
export const createTaskCommands = (state: PlannerState, input: QuickAdd, fallback: Placement, edge: 'top' | 'bottom' = 'bottom', today?: DateKey, folderId?: string | null): EventBody[] =>
  createManyTaskCommands(state, [input], fallback, { edge, today, folderId });

export const moveTo = (state: PlannerState, taskId: string, placement: Placement, edge: 'top' | 'bottom' = 'bottom'): EventBody => ({
  type: 'task.moved',
  taskId,
  placement,
  position: edgePosition(state, placement, edge),
});
