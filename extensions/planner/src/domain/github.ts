// GitHub issues and pull requests as a task source (read-only).
import type { Placement, PlannerState, Task, TaskSourceRef } from './types.ts';
import type { EventBody, NewTask } from './events.ts';

export interface GitHubItem {
  /** GraphQL node id. */
  id: string;
  kind: 'issue' | 'pull';
  /** owner/name */
  repo: string;
  number: number;
  /** owner/name#number */
  key: string;
  title: string;
  url: string;
  /** OPEN, CLOSED or MERGED. */
  state: string;
  draft: boolean;
  updatedAt: string;
}

const STATE_LOOK: Record<string, { name: string; color: string }> = {
  OPEN: { name: 'Open', color: '#2da44e' },
  CLOSED: { name: 'Closed', color: '#cf222e' },
  MERGED: { name: 'Merged', color: '#8250df' },
};

/** Closed and merged count as done, like a completed Linear issue. */
export const githubStatus = (item: GitHubItem): NonNullable<TaskSourceRef['status']> => {
  if (item.state === 'OPEN' && item.draft) return { name: 'Draft', type: 'open', color: '#6e7781' };
  const look = STATE_LOOK[item.state] ?? STATE_LOOK.OPEN!;
  return { name: look.name, type: item.state === 'OPEN' ? 'open' : 'completed', color: look.color };
};

export const githubSource = (item: GitHubItem): TaskSourceRef => ({ kind: 'github', id: item.id, key: item.key, url: item.url, title: item.title, status: githubStatus(item) });

export const taskFromGitHub = (item: GitHubItem, id: string, placement: Placement, position: number): NewTask => ({ id, title: item.title, placement, position, source: githubSource(item) });

/** An issue's or a pull request's address on GitHub, pasted from the browser (a comment's or a tab's address too). */
const ITEM_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/(issues|pull)\/(\d{1,9})(?:[/?#]\S*)?$/;

/**
 * A GitHub issue or pull request URL, as Sunsama imports one pasted into a new task's title: its repository, number
 * and kind, and its address without what follows the number (a comment, the files tab). Null for anything else.
 */
export const parseGitHubUrl = (text: string): { repo: string; number: number; kind: GitHubItem['kind']; key: string; url: string } | null => {
  const match = ITEM_URL.exec(text.trim());
  if (!match) return null;
  const [, owner, name, path, number] = match;
  const repo = `${owner}/${name}`;
  return { repo, number: Number(number), kind: path === 'pull' ? 'pull' : 'issue', key: `${repo}#${Number(number)}`, url: `https://github.com/${repo}/${path}/${Number(number)}` };
};

/** A short label for a GitHub key: name#12 instead of owner/name#12. */
export const shortKey = (key: string): string => key.replace(/^[^/]+\//, '');

/**
 * The live task planning a GitHub item (an open one first): linked to the item,
 * or to the Linear issue Linear keeps in sync with it.
 */
export const taskForGitHub = (state: PlannerState, item: Pick<GitHubItem, 'id' | 'key'>): Task | null => {
  const linked = Object.values(state.tasks).filter(
    (task) =>
      !task.deletedAt &&
      !task.archivedAt &&
      ((task.source?.kind === 'github' && task.source.id === item.id) || (task.source?.kind === 'linear' && Boolean(task.source.mirrors?.includes(item.key)))),
  );
  return linked.find((task) => !task.completedAt) ?? linked[0] ?? null;
};

export const linkedGitHubIds = (state: PlannerState): string[] =>
  [...new Set(Object.values(state.tasks).filter((task) => task.source?.kind === 'github' && !task.deletedAt && !task.archivedAt && !task.completedAt).map((task) => task.source!.id))];

/** Keep linked tasks' GitHub state and title current; a renamed task keeps its own title. */
export const planGitHubSync = (state: PlannerState, items: ReadonlyMap<string, GitHubItem>): EventBody[] => {
  const bodies: EventBody[] = [];
  for (const task of Object.values(state.tasks)) {
    const source = task.source;
    if (source?.kind !== 'github' || task.deletedAt || task.archivedAt) continue;
    const item = items.get(source.id);
    if (!item) continue;
    const next = githubSource(item);
    const titleFollows = source.title !== undefined && task.title === source.title && item.title !== source.title;
    const changed = source.title !== next.title || source.url !== next.url || source.key !== next.key || source.status?.name !== next.status?.name || source.status?.color !== next.status?.color;
    if (changed) bodies.push({ type: 'task.sourceSynced', taskId: task.id, source: next, ...(titleFollows ? { title: item.title } : {}) });
  }
  return bodies;
};

/** Shape check for an item that arrives through drag data. */
export const isGitHubItem = (value: unknown): value is GitHubItem => {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && typeof item.key === 'string' && typeof item.title === 'string' && typeof item.url === 'string' && /^https:\/\//.test(item.url) && typeof item.state === 'string' && (item.kind === 'issue' || item.kind === 'pull');
};
