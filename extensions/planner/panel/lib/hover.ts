// The task card under the pointer, for Sunsama's hover shortcuts (C, Z, X).
// Kept outside component state: hovering must not re-render the board.
let hovered: string | null = null;

export const setHoveredTask = (taskId: string | null): void => {
  hovered = taskId;
};

export const hoveredTask = (): string | null => hovered;
