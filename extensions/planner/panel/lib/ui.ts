// View-only state shared across components (never persisted to the event log).
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { Task } from '../../src/domain/types.ts';

export interface UiState {
  /** Task shown in the detail modal. */
  openTaskId: string | null;
  /** Channel filter: a channel id, 'none' for tasks without a channel, or null for all. */
  channelFilter: string | null;
  /** Task chosen in Focus; null follows the running timer or the first open task. */
  focusTaskId: string | null;
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

export const matchesFilter = (task: Task, filter: string | null): boolean =>
  filter === null || (filter === 'none' ? task.channelId === null : task.channelId === filter);
