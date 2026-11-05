// View-only state shared across components (never persisted to the event log).
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { Channel, Task } from '../../../src/domain/core/types.ts';

/** The Planner's pages, as its menu lists them. */
export type Route = 'home' | 'today' | 'calendar' | 'focus' | 'planning' | 'shutdown' | 'highlights' | 'weeklyPlanning' | 'weeklyReview' | 'backlog' | 'linear' | 'github' | 'google' | 'agents' | 'archive' | 'stats' | 'settings';

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
  /** The agent form the task detail opens with: assign (worktree and pull request) or send (choose everything). */
  agentForm: 'assign' | 'send' | null;
}

interface UiContextValue {
  ui: UiState;
  setUi: (patch: Partial<UiState>) => void;
}

export const UiContext = createContext<UiContextValue | null>(null);

/**
 * The surfaces that draw the whole Planner: its rail panel (OpenChamber's right panel; oc-forge keeps it loaded for
 * the window, the same in every chat) and an extension page on a host that opens one. The Work Status section and
 * the hidden frame that answers actions and commands draw less.
 */
/** The whole Planner: the rail panel (it has no page since 2026-11-05). */
export const isFullSurface = (surface: string): boolean => surface === 'panel';

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
