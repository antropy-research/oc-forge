// Human-readable activity lines for one task, like Sunsama's task history.
import type { PlannerEvent } from './events.ts';
import { BACKLOG_BUCKETS, SOURCE_NAMES, type Placement, type PlannerState } from './types.ts';
import { formatMinutes, monthDay } from './dates.ts';

const where = (placement: Placement): string =>
  placement.kind === 'day' ? monthDay(placement.date) : BACKLOG_BUCKETS.find((bucket) => bucket.id === placement.bucket)!.label.toLowerCase();

const PRIORITY = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' } as const;

/** A subtask as its activity line names it: as the change saw it, else as it is now, else "a subtask" (deleted since). */
const subtaskName = (state: PlannerState, taskId: string, subtaskId: string, seen?: string): string => {
  const title = seen ?? state.tasks[taskId]?.subtasks.find((subtask) => subtask.id === subtaskId)?.title;
  return title ? `“${title}”` : 'a subtask';
};

/** Does this event concern `taskId`? */
export const touchesTask = (event: PlannerEvent, taskId: string): boolean => {
  if (event.type === 'task.created') return event.task.id === taskId;
  if (event.type === 'tasks.rolledOver') return event.moved.some((item) => item.taskId === taskId) || event.archived.includes(taskId) || (event.superseded ?? []).includes(taskId);
  if (event.type === 'run.started') return event.run.taskId === taskId;
  return 'taskId' in event && event.taskId === taskId;
};

export const describe = (event: PlannerEvent, taskId: string, state: PlannerState): string => {
  switch (event.type) {
    case 'task.created':
      return `created this in ${where(event.task.placement)}`;
    case 'task.updated': {
      const parts = Object.entries(event.patch).map(([key, value]) => {
        if (key === 'title') return 'renamed this';
        if (key === 'notes') return 'edited the notes';
        if (key === 'plannedMinutes') return value == null ? 'cleared the planned time' : `set planned time to ${formatMinutes(value as number)}`;
        if (key === 'priority') return value ? `set priority to ${PRIORITY[value as keyof typeof PRIORITY]}` : 'cleared the priority';
        if (key === 'dueDate') return value ? `set the due date to ${monthDay(value as string)}` : 'cleared the due date';
        if (key === 'channelId') return value ? `moved this to #${state.channels[value as string]?.name ?? 'channel'}` : 'removed the channel';
        if (key === 'subtasks') return 'updated subtasks';
        if (key === 'source') return value ? `linked this to ${(value as { key: string }).key}` : 'removed the link';
        return `changed ${key}`;
      });
      return parts.join(', ');
    }
    case 'subtask.added':
      return `updated subtasks: added “${event.subtask.title}”`;
    case 'subtask.updated': {
      const name = subtaskName(state, event.taskId, event.subtaskId, event.seen?.title);
      if (event.patch.title !== undefined) return `updated subtasks: renamed ${name} to “${event.patch.title}”`;
      if (event.patch.done !== undefined) return `updated subtasks: ${event.patch.done ? 'checked off' : 'unchecked'} ${name}`;
      return `updated subtasks: updated ${name}`;
    }
    case 'subtask.deleted':
      return `updated subtasks: deleted ${subtaskName(state, event.taskId, event.subtaskId, event.seen?.title)}`;
    case 'subtask.moved':
      return `updated subtasks: moved ${subtaskName(state, event.taskId, event.subtaskId)}`;
    case 'task.moved':
      return `moved this to ${where(event.placement)}`;
    case 'task.completed':
      return 'completed this';
    case 'task.reopened':
      return 'marked this incomplete';
    case 'task.deleted':
      return 'deleted this';
    case 'task.restored':
      return 'restored this';
    case 'task.archived':
      return 'archived this';
    case 'task.sourceSynced':
      return `${event.source.key} is ${event.source.status?.name ?? 'updated'} in ${SOURCE_NAMES[event.source.kind]}${event.title ? ', title updated' : ''}`;
    case 'tasks.rolledOver':
      if ((event.superseded ?? []).includes(taskId)) return 'replaced this with the next repeat';
      return event.archived.includes(taskId) ? 'archived this after repeated rollovers' : `rolled this over to ${monthDay(event.date)}`;
    case 'run.started': {
      const inWorktree = event.run.worktree ? ` in worktree ${event.run.worktree.branch ?? event.run.worktree.directory}` : '';
      return event.run.wantsPr ? `assigned this to an agent${inWorktree}` : `started an agent${inWorktree}`;
    }
    case 'run.pullRequest': {
      const pr = event.pullRequest;
      const what = pr.state === 'merged' ? 'was merged' : pr.state === 'closed' ? 'was closed' : pr.draft ? 'is open as a draft' : 'is open';
      return `pull request ${pr.repo}#${pr.number} ${what}`;
    }
    default:
      return event.type;
  }
};

/** "just now", "5m ago", "3h ago", "2d ago", "1mo ago". */
export const timeAgo = (iso: string, now: number = Date.now()): string => {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = hours / 24;
  if (days < 30) return `${Math.floor(days)}d ago`;
  const months = days / 30;
  return months < 12 ? `${Math.floor(months)}mo ago` : `${Math.floor(months / 12)}y ago`;
};
