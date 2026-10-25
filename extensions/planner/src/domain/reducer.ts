// Fold events into state. Pure apart from mutating the batch-local copy it creates.
import { emptyState, type PlannerState, type Task } from './types.ts';
import type { PlannerEvent } from './events.ts';
import { daysBetween } from './dates.ts';
import { samePlacement } from './selectors.ts';

const touch = (state: PlannerState, taskId: string, at: string, change: (task: Task) => Task): void => {
  const task = state.tasks[taskId];
  // A merged log can reference a task this replica never saw; skip rather than invent it.
  if (!task) return;
  state.tasks[taskId] = { ...change(task), updatedAt: at };
};

const applyInto = (state: PlannerState, event: PlannerEvent): void => {
  state.version += 1;
  switch (event.type) {
    case 'task.created': {
      const input = event.task;
      if (state.tasks[input.id]) return;
      state.tasks[input.id] = {
        id: input.id,
        title: input.title.trim(),
        notes: input.notes ?? '',
        plannedMinutes: input.plannedMinutes ?? null,
        priority: input.priority ?? null,
        placement: input.placement,
        position: input.position,
        completedAt: null,
        completedOn: null,
        rolloverCount: 0,
        archivedAt: null,
        deletedAt: null,
        createdAt: event.at,
        updatedAt: event.at,
        channelId: input.channelId ?? null,
        subtasks: [],
        source: input.source ?? null,
      };
      return;
    }
    case 'task.updated':
      touch(state, event.taskId, event.at, (task) => ({
        ...task,
        ...event.patch,
        ...(event.patch.title !== undefined ? { title: event.patch.title.trim() } : {}),
      }));
      return;
    case 'task.moved':
      touch(state, event.taskId, event.at, (task) => ({
        ...task,
        placement: event.placement,
        position: event.position,
        // Rescheduling by hand restarts the carry-forward count; reordering within a list keeps it.
        rolloverCount: samePlacement(task.placement, event.placement) ? task.rolloverCount : 0,
        // A move is also how a task comes back out of the archive.
        archivedAt: null,
      }));
      return;
    case 'task.completed':
      touch(state, event.taskId, event.at, (task) => ({ ...task, completedAt: event.at, completedOn: event.on }));
      return;
    case 'task.reopened':
      touch(state, event.taskId, event.at, (task) => ({ ...task, completedAt: null, completedOn: null }));
      return;
    case 'task.deleted':
      touch(state, event.taskId, event.at, (task) => ({ ...task, deletedAt: event.at }));
      return;
    case 'task.restored':
      touch(state, event.taskId, event.at, (task) => ({ ...task, deletedAt: null, archivedAt: null }));
      return;
    case 'task.archived':
      touch(state, event.taskId, event.at, (task) => ({ ...task, archivedAt: event.at }));
      return;
    case 'tasks.rolledOver':
      for (const rolled of event.moved) {
        touch(state, rolled.taskId, event.at, (task) => ({
          ...task,
          placement: { kind: 'day', date: event.date },
          position: rolled.position,
          rolloverCount: task.rolloverCount + Math.max(1, daysBetween(rolled.from, event.date)),
        }));
      }
      for (const taskId of event.archived) {
        touch(state, taskId, event.at, (task) => ({ ...task, archivedAt: event.at }));
      }
      return;
    case 'channel.created': {
      if (state.channels[event.channel.id]) return;
      state.channels[event.channel.id] = { ...event.channel, createdAt: event.at, deletedAt: null };
      return;
    }
    case 'channel.updated': {
      const channel = state.channels[event.channelId];
      if (channel) state.channels[event.channelId] = { ...channel, ...event.patch };
      return;
    }
    case 'channel.deleted': {
      const channel = state.channels[event.channelId];
      if (!channel) return;
      state.channels[event.channelId] = { ...channel, deletedAt: event.at };
      // Deleting a channel never deletes its tasks; they just lose the label.
      for (const task of Object.values(state.tasks)) {
        if (task.channelId === event.channelId) state.tasks[task.id] = { ...task, channelId: null, updatedAt: event.at };
      }
      return;
    }
    case 'settings.updated':
      state.settings = { ...state.settings, ...event.patch };
      return;
  }
};

/** Apply a batch; copies the containers once and replaces only the tasks it touches. */
export const applyEvents = (state: PlannerState, events: readonly PlannerEvent[]): PlannerState => {
  if (events.length === 0) return state;
  const next: PlannerState = { ...state, tasks: { ...state.tasks }, channels: { ...state.channels }, settings: { ...state.settings } };
  for (const event of events) applyInto(next, event);
  return next;
};

/** Order a merged log deterministically: by time, then by id. */
export const sortEvents = (events: PlannerEvent[]): PlannerEvent[] =>
  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export const foldEvents = (events: readonly PlannerEvent[]): PlannerState => applyEvents(emptyState(), events);
