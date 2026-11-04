// The task card under the pointer, for Sunsama's hover shortcuts (C, Z, X).
import type { TaskSourceRef } from '../../src/domain/types.ts';

// Kept outside component state: hovering must not re-render the board.
let hovered: string | null = null;

export const setHoveredTask = (taskId: string | null): void => {
  hovered = taskId;
};

export const hoveredTask = (): string | null => hovered;

/** An item merged into a task (a subtask's link) under the pointer: G opens it in its tool, as Sunsama's subtasks do. */
let hoveredItem: TaskSourceRef | null = null;

export const setHoveredSource = (source: TaskSourceRef | null): void => {
  hoveredItem = source;
};

export const hoveredSource = (): TaskSourceRef | null => hoveredItem;
