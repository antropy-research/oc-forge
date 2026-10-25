// View-only state shared across components (never persisted to the event log).
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { Channel, Task } from '../../src/domain/types.ts';

export interface UiState {
  /** Task shown in the detail modal. */
  openTaskId: string | null;
  /** Channel filter: a channel id, 'none' for tasks without a channel, or null for all. */
  channelFilter: string | null;
  /** Task chosen in Focus; null follows the running timer or the first open task. */
  focusTaskId: string | null;
  /** Backlog folder filter: a folder id, 'none', or null for all. */
  folderFilter: string | null;
  /** Show Sunsama's playlist times on day lists. */
  playlist: boolean;
  /** Linear issue shown in the issue editor, above any task detail. */
  openIssue: { id: string; workspaceId: string | null } | null;
}

export interface UiContextValue {
  ui: UiState;
  setUi: (patch: Partial<UiState>) => void;
}

export const UiContext = createContext<UiContextValue | null>(null);

export const useUi = (): UiContextValue => {
  const value = useContext(UiContext);
  if (!value) throw new Error('UiContext is missing');
  return value;
};

/**
 * Channel filter: null for all, 'none' for tasks without a channel, 'ctx:work' or
 * 'ctx:personal' for a context (tasks without a channel count as work), or a channel id.
 */
export const matchesFilter = (task: Task, filter: string | null, channels: Record<string, Channel>): boolean => {
  if (filter === null) return true;
  if (filter === 'none') return task.channelId === null;
  if (filter === 'ctx:work') return !task.channelId || channels[task.channelId]?.context !== 'personal';
  if (filter === 'ctx:personal') return Boolean(task.channelId && channels[task.channelId]?.context === 'personal');
  return task.channelId === filter;
};
