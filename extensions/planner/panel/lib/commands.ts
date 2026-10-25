// Command builders shared by the views.
import type { EventBody } from '../../src/domain/events.ts';
import type { QuickAdd } from '../../src/domain/quickAdd.ts';
import { channelByName, edgePosition, liveChannels } from '../../src/domain/selectors.ts';
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

/** Commands for a parsed Add Task line; the line's `@` wins over the list it was typed in. */
export const createTaskCommands = (state: PlannerState, input: QuickAdd, fallback: Placement, edge: 'top' | 'bottom' = 'bottom', today?: DateKey): EventBody[] => {
  const bodies: EventBody[] = [];
  const channelId = input.channel ? ensureChannel(state, input.channel, bodies) : null;
  const placement = input.placement ?? fallback;
  // `$name` aligns to one of the week's objectives; an unknown name stays in the title.
  const week = weekStartOf(state, placement.kind === 'day' ? placement.date : today ?? new Date().toISOString().slice(0, 10));
  const objective = input.objective ? objectiveByText(state, week, input.objective) : null;
  const title = input.objective && !objective ? `${input.title} $${input.objective}` : input.title;
  bodies.push({
    type: 'task.created',
    task: { id: newId(), title, plannedMinutes: input.plannedMinutes, priority: input.priority, placement, position: edgePosition(state, placement, edge), channelId, objectiveId: objective?.id ?? null },
  });
  return bodies;
};

export const moveTo = (state: PlannerState, taskId: string, placement: Placement, edge: 'top' | 'bottom' = 'bottom'): EventBody => ({
  type: 'task.moved',
  taskId,
  placement,
  position: edgePosition(state, placement, edge),
});
