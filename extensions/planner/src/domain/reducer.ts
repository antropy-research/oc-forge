// Fold events into state. Pure apart from mutating the batch-local copy it creates.
import { emptyState, ritualKey, type PlannerState, type Task } from './types.ts';
import type { PlannerEvent } from './events.ts';
import { daysBetween, zonedDateMinutes } from './dates.ts';
import { samePlacement } from './selectors.ts';

const zoneOf = (state: PlannerState): string => state.settings.timezone ?? 'UTC';
const blockDate = (state: PlannerState, start: string): string => zonedDateMinutes(start, zoneOf(state)).date;

/**
 * Keep a task in step with its working sessions, as in Sunsama: its planned time
 * is the sessions' total length, and the task belongs to the day of the session
 * that just changed.
 */
const syncTaskToBlocks = (state: PlannerState, taskId: string, at: string, changedStart: string | null): void => {
  const task = state.tasks[taskId];
  if (!task) return;
  const blocks = Object.values(state.blocks).filter((block) => block.taskId === taskId);
  let next = task;
  if (blocks.length > 0) {
    const minutes = Math.round(blocks.reduce((sum, block) => sum + (Date.parse(block.end) - Date.parse(block.start)), 0) / 60_000);
    if (minutes !== task.plannedMinutes) next = { ...next, plannedMinutes: minutes };
  }
  if (changedStart) {
    const date = blockDate(state, changedStart);
    if (next.placement.kind !== 'day' || next.placement.date !== date) {
      const last = Object.values(state.tasks).reduce((max, other) => (other.placement.kind === 'day' && other.placement.date === date ? Math.max(max, other.position) : max), 0);
      next = { ...next, placement: { kind: 'day', date }, position: last + 1024, rolloverCount: 0, archivedAt: null };
    }
  }
  if (next !== task) state.tasks[taskId] = { ...next, updatedAt: at };
};

const touch = (state: PlannerState, taskId: string, at: string, change: (task: Task) => Task): void => {
  const task = state.tasks[taskId];
  // A merged log can reference a task this replica never saw; skip rather than invent it.
  if (!task) return;
  state.tasks[taskId] = { ...change(task), updatedAt: at };
};

/** Close the running timer into a time entry ending at `at`. */
const stopTimer = (state: PlannerState, at: string, entryId: string): void => {
  const timer = state.timer;
  if (!timer) return;
  state.timer = null;
  if (Date.parse(at) > Date.parse(timer.startedAt)) {
    state.entries[entryId] = { id: entryId, taskId: timer.taskId, start: timer.startedAt, end: at, source: 'timer' };
  }
};

/** Finishing, deleting or archiving a task stops its timer. */
const stopTimerFor = (state: PlannerState, taskId: string, event: PlannerEvent): void => {
  if (state.timer?.taskId === taskId) stopTimer(state, event.at, event.id);
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
        dueDate: input.dueDate ?? null,
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
        objectiveId: input.objectiveId ?? null,
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
    case 'task.moved': {
      // Dragging a card to another day drops its working sessions on the day it left;
      // sessions on other days stay as history.
      const before = state.tasks[event.taskId];
      if (before && before.placement.kind === 'day' && !samePlacement(before.placement, event.placement)) {
        const source = before.placement.date;
        for (const block of Object.values(state.blocks)) {
          if (block.taskId === event.taskId && blockDate(state, block.start) === source) delete state.blocks[block.id];
        }
      }
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
    }
    case 'task.completed':
      stopTimerFor(state, event.taskId, event);
      touch(state, event.taskId, event.at, (task) => ({ ...task, completedAt: event.at, completedOn: event.on }));
      return;
    case 'task.reopened':
      touch(state, event.taskId, event.at, (task) => ({ ...task, completedAt: null, completedOn: null }));
      return;
    case 'task.deleted':
      stopTimerFor(state, event.taskId, event);
      touch(state, event.taskId, event.at, (task) => ({ ...task, deletedAt: event.at }));
      return;
    case 'task.restored':
      touch(state, event.taskId, event.at, (task) => ({ ...task, deletedAt: null, archivedAt: null }));
      return;
    case 'task.archived':
      stopTimerFor(state, event.taskId, event);
      touch(state, event.taskId, event.at, (task) => ({ ...task, archivedAt: event.at }));
      return;
    case 'timer.started': {
      if (!state.tasks[event.taskId] || state.timer?.taskId === event.taskId) return;
      // One timer at a time: starting another task closes the running one.
      stopTimer(state, event.at, `${event.id}-prev`);
      state.timer = { taskId: event.taskId, startedAt: event.at };
      return;
    }
    case 'timer.stopped':
      stopTimer(state, event.at, event.id);
      return;
    case 'time.logged':
      if (!state.tasks[event.entry.taskId] || state.entries[event.entry.id]) return;
      state.entries[event.entry.id] = { ...event.entry, source: 'manual' };
      return;
    case 'time.deleted':
      delete state.entries[event.entryId];
      return;
    case 'block.created':
      if (!state.tasks[event.block.taskId] || state.blocks[event.block.id]) return;
      state.blocks[event.block.id] = { ...event.block };
      syncTaskToBlocks(state, event.block.taskId, event.at, event.block.start);
      return;
    case 'block.updated': {
      const block = state.blocks[event.blockId];
      if (!block) return;
      state.blocks[event.blockId] = { ...block, start: event.start, end: event.end };
      syncTaskToBlocks(state, block.taskId, event.at, event.start);
      return;
    }
    case 'block.deleted': {
      const block = state.blocks[event.blockId];
      if (!block) return;
      delete state.blocks[event.blockId];
      syncTaskToBlocks(state, block.taskId, event.at, null);
      return;
    }
    case 'objective.created':
      if (!state.objectives[event.objective.id]) {
        state.objectives[event.objective.id] = { ...event.objective, carriedFrom: event.objective.carriedFrom ?? null, title: event.objective.title.trim(), completedAt: null, createdAt: event.at, deletedAt: null };
      }
      return;
    case 'objective.updated': {
      const objective = state.objectives[event.objectiveId];
      if (!objective) return;
      state.objectives[event.objectiveId] = {
        ...objective,
        ...(event.patch.title !== undefined ? { title: event.patch.title.trim() } : {}),
        ...(event.patch.completed !== undefined ? { completedAt: event.patch.completed ? event.at : null } : {}),
      };
      return;
    }
    case 'objective.deleted': {
      const objective = state.objectives[event.objectiveId];
      if (!objective) return;
      state.objectives[event.objectiveId] = { ...objective, deletedAt: event.at };
      // Aligned tasks keep their work; they just lose the alignment.
      for (const task of Object.values(state.tasks)) {
        if (task.objectiveId === event.objectiveId) state.tasks[task.id] = { ...task, objectiveId: null, updatedAt: event.at };
      }
      return;
    }
    case 'ritual.saved': {
      const key = ritualKey(event.ritual, event.date);
      state.rituals[key] = { ...state.rituals[key], ...event.fields };
      return;
    }
    case 'calendar.added':
      if (!state.calendars[event.calendar.id]) state.calendars[event.calendar.id] = { ...event.calendar, visible: true };
      return;
    case 'calendar.updated': {
      const calendar = state.calendars[event.calendarId];
      if (calendar) state.calendars[event.calendarId] = { ...calendar, ...event.patch };
      return;
    }
    case 'calendar.removed':
      delete state.calendars[event.calendarId];
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
  const next: PlannerState = {
    ...state,
    tasks: { ...state.tasks },
    channels: { ...state.channels },
    entries: { ...state.entries },
    blocks: { ...state.blocks },
    calendars: { ...state.calendars },
    objectives: { ...state.objectives },
    rituals: { ...state.rituals },
    settings: { ...state.settings },
  };
  for (const event of events) applyInto(next, event);
  return next;
};

/** Order a merged log deterministically: by time, then by id. */
export const sortEvents = (events: PlannerEvent[]): PlannerEvent[] =>
  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export const foldEvents = (events: readonly PlannerEvent[]): PlannerState => applyEvents(emptyState(), events);
