// What the Linear store (store.ts) shows: its view and the issue lists in it, and what a list is: where its issues
// come from, an empty one, and the display it uses.
import { settingsDisplay, type IssueDisplay, type ProjectDisplay } from '../../../src/domain/linear/display.ts';
import type { FilterCatalog, FilterJoin, LinearFilterNode } from '../../../src/domain/linear/filter.ts';
import type { LinearFavorite, LinearIssue, LinearProject, LinearProjectDetail, LinearSavedView, LinearViewMeta, LinearWorkspace } from '../../../src/domain/linear/linear.ts';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/domain/core/types.ts';

/** What an issue list shows: issues of mine, a saved view, a project's issues, or a search. */
export type LinearSource =
  | { kind: 'assigned' }
  | { kind: 'created' }
  | { kind: 'subscribed' }
  | { kind: 'view'; id: string; workspaceId: string }
  | { kind: 'project'; id: string; workspaceId: string }
  | { kind: 'search'; term: string };

/** The Linear page's list, and the one the side panels (Today, Calendar, planning) share. */
export type ListId = 'page' | 'side';

/** The Linear page's sections: issue lists, all projects, or the issues already in the plan. */
export type LinearMode = 'issues' | 'projects' | 'planned';

/**
 * A question to ask before changing an issue in Linear: Sunsama's "Show prompt to update status in Linear", after
 * completing, planning (the Planner's) or importing an issue.
 */
export interface LinearPrompt {
  kind: 'complete' | 'start' | 'import';
  taskId: string;
  /** The issue it names; asked about several, the first one's key and how many more. */
  key: string;
  /** An issue merged into the task (a subtask with its link), not the task's own. */
  subtaskId?: string;
  /**
   * A task completed with issues merged into it: asked once about all of them (and the task's own, `own`), each then
   * moved to its team's first completed state (one status picker can't serve several teams).
   */
  many?: { own: boolean; subtaskIds: string[] };
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
  workspaceId: string;
}

/** An issue to open in the editor; a null workspace means OpenChamber's connection. */
export interface IssueRef {
  id: string;
  workspaceId: string | null;
}

export interface WorkspaceView extends LinearWorkspace {
  /** Why the last request there failed, until one succeeds. */
  error: string | null;
}

export interface OpenProject {
  project: LinearProject;
  detail: LinearProjectDetail | null;
  loading: boolean;
  error: string | null;
  /** Where "back" goes: the view of projects it was opened from, or all projects. */
  from: { kind: 'view'; id: string; workspaceId: string; name: string } | null;
}

export interface IssueList {
  source: LinearSource;
  /**
   * The filter bar's filters, as in Linear: rules and groups. A new source
   * starts without any; a saved view starts with its own, which can be changed
   * here (not saved back).
   */
  filters: LinearFilterNode[];
  /** Whether all or any of the top-level filters must hold. */
  match: FilterJoin;
  /** An open view's own filters, as saved; null for lists that are not a view. */
  viewFilters: LinearFilterNode[] | null;
  /** The open saved view: its name, what it lists, the display saved with it. */
  view: LinearViewMeta | null;
  /** The open view's display, as saved, then as changed here (not saved back). Null: the Planner's own settings. */
  display: IssueDisplay | null;
  /** A view of projects: its grouping, ordering and completed projects. */
  projectDisplay: ProjectDisplay | null;
  /** What of the view's display the Planner shows another way. */
  unsupported: string[];
  issues: LinearIssue[];
  /** A view of projects lists projects instead of issues. */
  projects: LinearProject[] | null;
  /** Workspaces Linear has more pages for, with the cursor to read on from. */
  more: Record<string, string>;
  /** Pages read per workspace, so a refresh reads as many again. */
  pages: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

export interface LinearView {
  /** OpenChamber's own Linear connection; null until the host or a request says. */
  connected: boolean | null;
  account: string;
  /** Workspaces the Planner reads, OpenChamber's connection first. */
  workspaces: WorkspaceView[];
  /** 'all', or the id of the one workspace shown. */
  scope: string;
  mode: LinearMode;
  lists: Record<ListId, IssueList>;
  /** Saved views (of issues and of projects), from every connected workspace. */
  views: LinearSavedView[];
  viewsLoaded: boolean;
  /** Workspaces with more saved views than read so far: where the next page starts (Load more views). */
  viewsMore: Record<string, string>;
  /** Linear has more favorites than were read (page.ts reads MAX_FAVORITE_PAGES of 250): the sidebar says so. */
  favoritesCut?: boolean;
  /** My favorites in Linear's sidebar: views, projects and issues. */
  favorites: LinearFavorite[];
  /** Current issues behind open linked tasks, by issue id. */
  linked: Record<string, LinearIssue>;
  projects: LinearProject[];
  projectsLoaded: boolean;
  projectsLoading: boolean;
  /** Workspaces with more open projects than read so far: where the next page starts (Load more). */
  projectsMore: Record<string, string>;
  project: OpenProject | null;
  /** What filters offer and boards need, by workspace: teams and their states, people, labels, projects, cycles. */
  catalogs: Record<string, FilterCatalog>;
  /** A connection-wide problem (the host connection could not be identified). */
  error: string | null;
  syncedAt: number | null;
  prompt: LinearPrompt | null;
  /** Issues with a change on its way to Linear. */
  moving: ReadonlySet<string>;
}

export const emptyList = (source: LinearSource = { kind: 'assigned' }): IssueList => ({
  source,
  filters: [],
  match: 'and',
  viewFilters: null,
  view: null,
  display: null,
  projectDisplay: null,
  unsupported: [],
  issues: [],
  projects: null,
  more: {},
  pages: 0,
  loading: false,
  loadingMore: false,
  error: null,
});

export const sameSource = (a: LinearSource, b: LinearSource): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Issues of mine: assigned to me, created by me, or that I am subscribed to. */
export const isMine = (source: { kind?: unknown }): boolean => source.kind === 'assigned' || source.kind === 'created' || source.kind === 'subscribed';

/** The display a list uses: the open view's own, or the Planner's settings (side panels list open issues). */
export const displayOf = (list: Pick<IssueList, 'display' | 'source'>, settings: Settings, listId: ListId = 'page'): IssueDisplay => {
  if (list.display) return list.display;
  const display = settingsDisplay({ ...settings, linearDisplay: { ...DEFAULT_SETTINGS.linearDisplay, ...settings.linearDisplay } });
  // The panel beside a day is Sunsama's: its My issues keep completed issues for five days; a search, open ones.
  return listId === 'side' ? { ...display, showCompleted: isMine(list.source) ? '5days' : 'none' } : display;
};
