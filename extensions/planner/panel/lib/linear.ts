// Panel-side Linear: issue lists and projects from every connected workspace
// (OpenChamber's own Linear connection, plus workspaces added with an API key,
// whose keys the local service keeps), planning issues as tasks, and writing
// completion back the way Sunsama does (ask, do, or not).
//
// Lists are Linear's: a saved view lists exactly the issues Linear lists for
// it (its own filter, plus what its display hides), page after page until
// Linear has no more; temporary filters go to Linear as an IssueFilter, so the
// answer is complete. The Linear page and the side panels keep a list each.
import { HostRequestError, type HostClient } from '@openchamber/sdk';
import type { Command, EventBody } from '../../src/domain/events.ts';
import {
  ADD_COMMENT_MUTATION,
  ASSIGNED_QUERY,
  CREATED_QUERY,
  CREATE_ISSUE_MUTATION,
  FAVORITE_VIEWS_QUERY,
  FILTER_CYCLES_QUERY,
  FILTER_LABELS_QUERY,
  FILTER_PROJECTS_QUERY,
  FILTER_TEAMS_QUERY,
  FILTER_USERS_QUERY,
  ISSUES_QUERY,
  ISSUE_DETAIL_QUERY,
  ISSUE_QUERY,
  LINKED_QUERY,
  PROJECTS_QUERY,
  PROJECT_QUERY,
  SEARCH_QUERY,
  SET_STATE_MUTATION,
  TEAMS_QUERY,
  TEAM_OPTIONS_QUERY,
  TEAM_STATES_QUERY,
  UPDATE_ISSUE_MUTATION,
  VIEWS_QUERY,
  VIEW_ISSUES_QUERY,
  VIEW_PROJECTS_QUERY,
  VIEW_QUERY,
  WHOAMI_QUERY,
  favoriteOrder,
  favoritesOf,
  githubMirrors,
  inWorkspace,
  isClosedType,
  isProjectView,
  issueSource,
  linkedIssueIdsByWorkspace,
  linkedTask,
  planLinearSync,
  planTextSave,
  priorityToLinear,
  readGraphql,
  stateOfType,
  taskFromIssue,
  workflowOrder,
  type IssueInput,
  type IssueText,
  type LinearComment,
  type LinearCycle,
  type LinearFavorite,
  type LinearFavoriteNode,
  type LinearIssue,
  type LinearIssueDetail,
  type LinearLabel,
  type LinearProject,
  type LinearProjectDetail,
  type LinearSavedView,
  type LinearState,
  type LinearViewMeta,
  type LinearWorkspace,
  type TeamOptions,
} from '../../src/domain/linear.ts';
import {
  allOf,
  displayFilter,
  dropInput,
  projectDisplayFilter,
  projectViewDisplay,
  readPages,
  settingsDisplay,
  viewDisplay,
  type GraphFilter,
  type GroupTarget,
  type IssueDisplay,
  type Page,
  type ProjectDisplay,
} from '../../src/domain/linearDisplay.ts';
import { compileFilter, matchesRules, workspacesFor, type FilterCatalog, type FilterContext, type LinearFilterRule } from '../../src/domain/linearFilter.ts';
import { edgePosition } from '../../src/domain/selectors.ts';
import { newId } from '../../src/domain/ids.ts';
import { DEFAULT_SETTINGS, type LinearDisplayPrefs, type Placement, type PlannerState, type Settings, type Task, type TaskSourceRef } from '../../src/domain/types.ts';
import type { Origin, PlannerClient } from './client.ts';

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

/** A question to ask before changing an issue in Linear. */
export interface LinearPrompt {
  kind: 'complete' | 'start';
  taskId: string;
  key: string;
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
  /** Temporary filters, as in Linear; a new source starts without any. */
  filters: LinearFilterRule[];
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
  /** My favorites in Linear's sidebar: views, projects and issues. */
  favorites: LinearFavorite[];
  /** Current issues behind open linked tasks, by issue id. */
  linked: Record<string, LinearIssue>;
  projects: LinearProject[];
  projectsLoaded: boolean;
  projectsLoading: boolean;
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

/** Where the Linear page was, kept on this device so it opens there again. */
export interface LinearLocation {
  mode: LinearMode;
  source: LinearSource;
  scope: string;
  project?: { id: string; workspaceId: string } | null;
}

const REFRESH_MS = 5 * 60_000;
/** Pages a list reads at once (100 issues each); further pages come on scroll or Load more. */
const FIRST_PAGES = 3;
const MAX_PROJECT_PAGES = 10;
const MAX_VIEW_PAGES = 10;
const MAX_CATALOG_PAGES = 20;
const CATALOG_MS = 10 * 60_000;
const LOCATION_KEY = 'linear.location';
const STATE_WORDS: Record<string, string> = { completed: 'Done', started: 'In Progress', unstarted: 'Todo', backlog: 'Backlog', triage: 'Triage' };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const emptyList = (source: LinearSource = { kind: 'assigned' }): IssueList => ({
  source,
  filters: [],
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

const isSource = (value: unknown): value is LinearSource => {
  const item = value as Record<string, unknown> | null;
  if (!item || typeof item !== 'object') return false;
  if (item.kind === 'assigned' || item.kind === 'created' || item.kind === 'subscribed') return true;
  if (item.kind === 'view' || item.kind === 'project') return typeof item.id === 'string' && typeof item.workspaceId === 'string';
  return item.kind === 'search' && typeof item.term === 'string';
};

/** The display a list uses: the open view's own, or the Planner's settings (side panels list open issues). */
export const displayOf = (list: Pick<IssueList, 'display' | 'source'>, settings: Settings, listId: ListId = 'page'): IssueDisplay => {
  if (list.display) return list.display;
  const display = settingsDisplay({ ...settings, linearDisplay: { ...DEFAULT_SETTINGS.linearDisplay, ...settings.linearDisplay } });
  return listId === 'side' ? { ...display, showCompleted: 'none' } : display;
};

/** Whether a changed issue still belongs in a list, judged as Linear would by its filter and display. */
const stillListed = (issue: LinearIssue, list: IssueList, display: IssueDisplay, context: FilterContext): boolean => {
  if (!matchesRules(issue, list.filters, context)) return false;
  if (isClosedType(issue.state.type) && display.showCompleted === 'none') return false;
  if (!display.showSubIssues && issue.parent) return false;
  if (!display.showTriage && issue.state.type === 'triage') return false;
  if (list.source.kind === 'project' && issue.project?.id !== list.source.id) return false;
  return true;
};

export class LinearStore {
  private view: LinearView = {
    connected: null,
    account: '',
    workspaces: [],
    scope: 'all',
    mode: 'issues',
    lists: { page: emptyList(), side: emptyList() },
    views: [],
    viewsLoaded: false,
    favorites: [],
    linked: {},
    projects: [],
    projectsLoaded: false,
    projectsLoading: false,
    project: null,
    catalogs: {},
    error: null,
    syncedAt: null,
    prompt: null,
    moving: new Set(),
  };
  private readonly listeners = new Set<() => void>();
  private readonly teamStates = new Map<string, LinearState[]>();
  private readonly teamLists = new Map<string, LinearTeam[]>();
  private readonly teamOptionCache = new Map<string, TeamOptions>();
  /** My user id in each workspace, for assigning new issues. */
  private readonly viewerIds = new Map<string, string>();
  private hostWorkspace: WorkspaceView | null = null;
  private keyWorkspaces: WorkspaceView[] = [];
  private identifying: Promise<boolean> | null = null;
  private readonly listSeq: Record<ListId, number> = { page: 0, side: 0 };
  /** Lists something has shown; a refresh reads only those. */
  private readonly used = new Set<ListId>();
  private projectSeq = 0;
  private started = false;
  private catalogLoads = new Map<string, Promise<void>>();
  private catalogTimes = new Map<string, number>();
  /** The issues the Linear page shows, in order, for moving through them in the issue view. */
  private order: IssueRef[] = [];
  private restoring: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** A project to reopen once its workspace is connected. */
  private pendingProject: { id: string; workspaceId: string } | null = null;

  constructor(private readonly host: HostClient, private readonly client: PlannerClient, private readonly surface: string) {}

  getView = (): LinearView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Some workspace can be read. */
  available(): boolean {
    return this.view.workspaces.length > 0;
  }

  /** Begin following the connection, refreshing, and answering completed tasks. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.restoring = this.surface === 'page' ? this.restoreLocation() : Promise.resolve();
    this.host.onConnection((connection) => {
      const was = this.view.connected;
      const accountChanged = was === true && connection.account !== this.view.account;
      this.set({ connected: connection.connected, account: connection.account });
      if (!connection.connected) this.setHost(null);
      else if (was !== true || accountChanged) {
        // Reconnected, perhaps to another workspace: find out which before reading it.
        this.hostWorkspace = null;
        void this.refresh(true);
      }
    });
    this.client.onCommitted((commands, before, after, origin) => this.afterCommit(commands, before, after, origin));
    void this.loadKeyWorkspaces().then(() => {
      if (this.keyWorkspaces.length) void this.refresh(true);
    });
    // If the host has not said whether Linear is connected, a request finds out.
    setTimeout(() => {
      if (this.view.connected === null) void this.refresh(true);
    }, 1500);
    setInterval(() => {
      if (this.available() && !document.hidden) void this.refresh();
    }, REFRESH_MS);
  }

  connect(): Promise<void> {
    return this.host.oauthStart();
  }

  list(id: ListId): IssueList {
    return this.view.lists[id];
  }

  /** A list is on screen: read it if it has not been read yet. */
  use(id: ListId): void {
    if (this.used.has(id)) return;
    this.used.add(id);
    void this.loadList(id);
  }

  /** Show another list; like opening another view in Linear, it starts without temporary filters. */
  setSource(source: LinearSource, id: ListId = 'page'): void {
    this.used.add(id);
    this.patchList(id, { ...emptyList(source), loading: true });
    if (id === 'page') this.set({ mode: 'issues', project: null });
    void this.loadList(id);
    if (id === 'page') this.saveLocation();
  }

  /** Temporary filters, sent to Linear with the list's own: the answer is every matching issue. */
  setFilters(filters: LinearFilterRule[], id: ListId = 'page'): void {
    const kept = filters.filter((rule) => rule.values.length > 0);
    if (JSON.stringify(kept) === JSON.stringify(this.list(id).filters)) return;
    this.patchList(id, { filters: kept });
    void this.loadList(id);
  }

  setMode(mode: LinearMode): void {
    this.set({ mode, ...(mode !== 'projects' ? { project: null } : {}) });
    if (mode === 'projects' && !this.view.projectsLoaded && !this.view.projectsLoading) void this.loadProjects();
    this.saveLocation();
  }

  /** Show one workspace, or all of them merged. */
  setScope(scope: string): void {
    const fix = (list: IssueList): LinearSource =>
      (list.source.kind === 'view' || list.source.kind === 'project') && scope !== 'all' && list.source.workspaceId !== scope ? { kind: 'assigned' } : list.source;
    this.set({
      scope,
      lists: { page: { ...emptyList(fix(this.view.lists.page)), loading: true }, side: { ...emptyList(fix(this.view.lists.side)), loading: true } },
      projects: [],
      projectsLoaded: false,
      project: null,
    });
    for (const id of this.used) void this.loadList(id);
    if (this.view.mode === 'projects') void this.loadProjects();
    this.saveLocation();
  }

  /**
   * Change the display. An open view's changes last while it is open, as in
   * Linear until one saves the view; otherwise they are the Planner's settings.
   * A change of what is listed (completed issues, sub-issues) reads the list again.
   */
  setDisplay(patch: Partial<IssueDisplay>, id: ListId = 'page'): Promise<void> {
    const list = this.list(id);
    const settings = this.client.getView().state.settings;
    const before = displayOf(list, settings, id);
    const after = { ...before, ...patch };
    const reread = JSON.stringify(displayFilter(before)) !== JSON.stringify(displayFilter(after));
    if (list.display) {
      this.patchList(id, { display: after });
      if (reread) void this.loadList(id);
      return Promise.resolve();
    }
    const settingsPatch: Partial<Settings> = {};
    if (patch.layout) settingsPatch.linearLayout = patch.layout;
    if (patch.groupBy) settingsPatch.linearGroupBy = patch.groupBy;
    if (patch.orderBy) settingsPatch.linearOrderBy = patch.orderBy;
    const rest: Partial<LinearDisplayPrefs> = {};
    for (const key of ['subGroupBy', 'orderReverse', 'showCompleted', 'showSubIssues', 'showEmptyGroups', 'showEmptyColumns', 'properties'] as const) {
      if (key in patch) (rest as Record<string, unknown>)[key] = patch[key];
    }
    if (Object.keys(rest).length) settingsPatch.linearDisplay = { ...DEFAULT_SETTINGS.linearDisplay, ...settings.linearDisplay, ...rest };
    return this.client.dispatch([{ type: 'settings.updated', patch: settingsPatch }]).then(() => {
      if (reread) void this.loadList(id);
    });
  }

  /** A view of projects: its grouping, ordering or completed projects, while it is open. */
  setProjectDisplay(patch: Partial<ProjectDisplay>, id: ListId = 'page'): void {
    const list = this.list(id);
    if (!list.projectDisplay) return;
    const next = { ...list.projectDisplay, ...patch };
    this.patchList(id, { projectDisplay: next });
    if (patch.showCompleted && patch.showCompleted !== list.projectDisplay.showCompleted) void this.loadList(id);
  }

  /** Reload the lists on screen and the issues behind linked tasks, then sync those tasks. */
  async refresh(withViews = false): Promise<void> {
    if (this.view.connected !== false && !this.hostWorkspace) await this.identifyHost();
    if (!this.available()) return;
    await this.restoring;
    const linked = await this.fetchLinked();
    this.noteErrors(linked.errors, linked.asked);
    this.set({ linked: linked.issues, syncedAt: Date.now() });
    for (const id of this.used) void this.loadList(id, true);
    this.reopenProject();
    if (withViews || !this.view.viewsLoaded) void this.loadViews();
    if (this.view.mode === 'projects' && this.view.projectsLoaded) void this.loadProjects();
    // The Work Status frame is a compact control; the page and rail panel keep tasks in sync.
    if (this.surface !== 'status') await this.sync(linked.issues);
  }

  /** Read the next page of every workspace that has more. */
  async loadMore(id: ListId = 'page'): Promise<void> {
    const list = this.list(id);
    const cursors = Object.entries(list.more);
    if (list.loading || list.loadingMore || cursors.length === 0) return;
    const seq = this.listSeq[id];
    this.patchList(id, { loadingMore: true });
    const settled = await Promise.allSettled(cursors.map(([workspaceId, after]) => this.readList(workspaceId, list, id, { after, maxPages: 1 })));
    if (seq !== this.listSeq[id]) return;
    const current = this.list(id);
    const more: Record<string, string> = {};
    const issues = [...current.issues];
    const projects = current.projects ? [...current.projects] : null;
    const seen = new Set([...issues.map((issue) => `${issue.workspaceId}:${issue.id}`), ...(projects ?? []).map((project) => `${project.workspaceId}:${project.id}`)]);
    let error: string | null = null;
    settled.forEach((result, index) => {
      const workspaceId = cursors[index]![0];
      if (result.status === 'rejected') {
        error = messageOf(result.reason);
        more[workspaceId] = cursors[index]![1];
        return;
      }
      for (const issue of result.value.issues) if (!seen.has(`${workspaceId}:${issue.id}`)) issues.push(issue);
      for (const project of result.value.projects) if (!seen.has(`${workspaceId}:${project.id}`)) projects?.push(project);
      if (result.value.endCursor) more[workspaceId] = result.value.endCursor;
    });
    this.patchList(id, { issues, projects, more, pages: current.pages + 1, loadingMore: false, error });
  }

  /** Projects of the shown workspaces that are not completed or canceled. */
  async loadProjects(): Promise<void> {
    if (this.view.connected !== false && !this.hostWorkspace) await this.identifyHost();
    if (!this.available()) return;
    const seq = ++this.projectSeq;
    const targets = this.scoped();
    this.set({ projectsLoading: true });
    const settled = await Promise.allSettled(
      targets.map((workspace) =>
        readPages<LinearProject>((after) => this.graphqlIn<{ projects: Page<LinearProject> }>(workspace.id, PROJECTS_QUERY, { after }).then((data) => data.projects), { maxPages: MAX_PROJECT_PAGES }),
      ),
    );
    if (seq !== this.projectSeq) return;
    const errors = new Map<string, string>();
    const projects: LinearProject[] = [];
    settled.forEach((result, index) => {
      const workspaceId = targets[index]!.id;
      if (result.status === 'fulfilled') projects.push(...result.value.nodes.map((project) => inWorkspace(project, workspaceId)));
      else errors.set(workspaceId, messageOf(result.reason));
    });
    this.noteErrors(errors, targets.map((workspace) => workspace.id));
    const allFailed = targets.length > 0 && errors.size === targets.length;
    this.set({ projects, projectsLoaded: true, projectsLoading: false, error: allFailed ? errors.get(targets[0]!.id) ?? null : this.view.error });
  }

  /** Open a project: its overview, and its issues as the page's list. */
  async openProject(project: LinearProject, from: OpenProject['from'] = null): Promise<void> {
    const workspaceId = project.workspaceId ?? '';
    this.set({ mode: 'projects', project: { project, detail: null, loading: true, error: null, from } });
    this.used.add('page');
    this.patchList('page', { ...emptyList({ kind: 'project', id: project.id, workspaceId }), loading: true });
    void this.loadList('page');
    this.saveLocation();
    try {
      const data = await this.graphqlIn<{ project: LinearProjectDetail | null }>(workspaceId, PROJECT_QUERY, { id: project.id });
      if (this.view.project?.project.id !== project.id) return;
      if (!data.project) throw new Error('Linear no longer has this project');
      this.set({ project: { project, detail: inWorkspace(data.project, workspaceId), loading: false, error: null, from } });
    } catch (error) {
      if (this.view.project?.project.id !== project.id) return;
      this.set({ project: { project, detail: null, loading: false, error: messageOf(error), from } });
    }
  }

  /** Back from a project: to the view of projects it came from, or to all projects. */
  closeProject(): void {
    const from = this.view.project?.from;
    this.set({ project: null });
    if (from) this.setSource({ kind: 'view', id: from.id, workspaceId: from.workspaceId });
    else this.setMode('projects');
  }

  /** Add a workspace with a personal API key; the service checks it with Linear and keeps it. */
  async addWorkspace(key: string): Promise<LinearWorkspace> {
    const { workspace } = await this.client.call<{ workspace: Omit<LinearWorkspace, 'via'> }>('POST', '/linear/workspaces', { key });
    if (this.hostWorkspace?.id === workspace.id) {
      await this.client.call('DELETE', `/linear/workspaces/${encodeURIComponent(workspace.id)}`).catch(() => {});
      throw new Error(`${workspace.name} is already connected through OpenChamber`);
    }
    await this.loadKeyWorkspaces();
    this.set({ projectsLoaded: false });
    void this.refresh(true);
    if (this.view.mode === 'projects') void this.loadProjects();
    return { ...workspace, via: 'key' };
  }

  async removeWorkspace(id: string): Promise<void> {
    await this.client.call('DELETE', `/linear/workspaces/${encodeURIComponent(id)}`);
    await this.loadKeyWorkspaces();
    const keep = <T extends { workspaceId?: string }>(items: T[]) => items.filter((item) => item.workspaceId !== id);
    const fixList = (list: IssueList): IssueList =>
      (list.source.kind === 'view' || list.source.kind === 'project') && list.source.workspaceId === id ? emptyList() : { ...list, issues: keep(list.issues), projects: list.projects ? keep(list.projects) : null };
    const catalogs = { ...this.view.catalogs };
    delete catalogs[id];
    this.set({
      lists: { page: fixList(this.view.lists.page), side: fixList(this.view.lists.side) },
      views: keep(this.view.views),
      favorites: this.view.favorites.filter((favorite) => favorite.workspaceId !== id),
      projects: keep(this.view.projects),
      catalogs,
      linked: Object.fromEntries(Object.entries(this.view.linked).filter(([, issue]) => issue.workspaceId !== id)),
      project: this.view.project?.project.workspaceId === id ? null : this.view.project,
    });
    for (const list of this.used) if (!this.list(list).issues.length) void this.loadList(list);
  }

  /** Commands that plan `issue` at `placement`: move its open task there, or create one. */
  importCommands(issue: LinearIssue, placement: Placement, position?: number): { bodies: EventBody[]; taskId: string } {
    const state = this.client.getView().state;
    const at = position ?? edgePosition(state, placement, 'bottom');
    const existing = linkedTask(state, issue.id, githubMirrors(issue));
    if (existing && !existing.completedAt) return { bodies: [{ type: 'task.moved', taskId: existing.id, placement, position: at }], taskId: existing.id };
    const id = newId();
    return { bodies: [{ type: 'task.created', task: taskFromIssue(issue, id, placement, at) }], taskId: id };
  }

  plan(issue: LinearIssue, placement: Placement, position?: number): Promise<void> {
    return this.client.dispatch(this.importCommands(issue, placement, position).bodies, { undo: `Planned ${issue.identifier}` });
  }

  /**
   * An issue by its identifier (NEX-110) or id; null when no connected workspace
   * knows it. `urlKey` (from an issue URL) picks the workspace it belongs to.
   */
  async issue(id: string, urlKey?: string): Promise<LinearIssue | null> {
    const candidates = urlKey ? this.view.workspaces.filter((workspace) => workspace.urlKey.toLowerCase() === urlKey.toLowerCase()) : this.view.workspaces;
    let failure: unknown = null;
    for (const workspace of candidates) {
      try {
        const issue = await this.issueIn(workspace.id, id);
        if (issue) return issue;
      } catch (error) {
        failure = error;
      }
    }
    if (failure && candidates.length === 1) throw failure;
    return null;
  }

  /** Teams of every connected workspace, for creating an issue. */
  async teams(): Promise<LinearTeam[]> {
    const settled = await Promise.allSettled(
      this.view.workspaces.map(async (workspace) => {
        const cached = this.teamLists.get(workspace.id);
        if (cached) return cached;
        const data = await this.graphqlIn<{ viewer: { id: string }; teams: { nodes: Omit<LinearTeam, 'workspaceId'>[] } }>(workspace.id, TEAMS_QUERY);
        this.viewerIds.set(workspace.id, data.viewer.id);
        const teams = data.teams.nodes.map((team) => ({ ...team, workspaceId: workspace.id }));
        this.teamLists.set(workspace.id, teams);
        return teams;
      }),
    );
    return settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  }

  /** Create an issue from a task, assigned to me, and link the task to it. */
  async createIssue(task: Task, team: LinearTeam): Promise<void> {
    if (!this.viewerIds.has(team.workspaceId)) await this.teams();
    const input: Record<string, unknown> = { teamId: team.id, title: task.title, assigneeId: this.viewerIds.get(team.workspaceId), priority: priorityToLinear(task.priority) };
    if (task.notes.trim()) input.description = task.notes;
    if (task.dueDate) input.dueDate = task.dueDate;
    const data = await this.graphqlIn<{ issueCreate: { success: boolean; issue: LinearIssue | null } }>(team.workspaceId, CREATE_ISSUE_MUTATION, { input });
    if (!data.issueCreate.success || !data.issueCreate.issue) throw new Error('Linear did not create the issue');
    const issue = inWorkspace(data.issueCreate.issue, team.workspaceId);
    this.set({ linked: { ...this.view.linked, [issue.id]: issue } });
    await this.client.dispatch([{ type: 'task.updated', taskId: task.id, patch: { source: issueSource(issue) } }]);
    this.client.notify(`Created ${issue.identifier} in Linear`);
  }

  /** Move the issue behind `task` to its team's first completed or started state. */
  moveIssue(task: Task, type: 'completed' | 'started'): Promise<boolean> {
    const source = task.source;
    if (source?.kind !== 'linear') return Promise.resolve(false);
    return this.moveTo({ id: source.id, key: source.key, teamId: source.teamId, workspaceId: this.workspaceOf(source) }, type, task);
  }

  /**
   * A card dropped on a group: its team's state of that exact name, or the
   * group's priority, assignee, project or cycle, as Linear does on a board.
   */
  async moveToGroup(issue: LinearIssue, target: GroupTarget): Promise<boolean> {
    const workspaceId = issue.workspaceId ?? this.hostWorkspace?.id ?? null;
    if (this.view.moving.has(issue.id)) return false;
    try {
      if (!workspaceId || !this.workspace(workspaceId)) throw new Error('its Linear workspace is not connected');
      const states = target.kind === 'state' ? await this.statesOf(workspaceId, issue.team.id) : [];
      const change = dropInput(issue, target, states);
      if (!change) return false;
      if ('error' in change) throw new Error(change.error);
      this.set({ moving: new Set([...this.view.moving, issue.id]) });
      const task = linkedTask(this.client.getView().state, issue.id);
      if (change.input.stateId) {
        const data = await this.graphqlIn<{ issueUpdate: { success: boolean; issue: LinearIssue | null } }>(workspaceId, SET_STATE_MUTATION, { id: issue.id, stateId: change.input.stateId });
        if (!data.issueUpdate.success || !data.issueUpdate.issue) throw new Error('Linear did not accept the change');
        const updated = inWorkspace(data.issueUpdate.issue, workspaceId);
        this.replaceIssue(updated);
        if (task && !task.completedAt) await this.client.dispatch([{ type: 'task.sourceSynced', taskId: task.id, source: issueSource(updated, task.source) }], { origin: 'linear' });
        this.client.notify(`${updated.identifier} is now ${updated.state.name} in Linear`);
      } else {
        await this.updateIssue({ id: issue.id, workspaceId }, change.input);
      }
      return true;
    } catch (error) {
      this.client.notify(`Couldn't move ${issue.identifier} in Linear: ${messageOf(error)}`);
      return false;
    } finally {
      if (this.view.moving.has(issue.id)) {
        const moving = new Set(this.view.moving);
        moving.delete(issue.id);
        this.set({ moving });
      }
    }
  }

  /** The issue with its Markdown description, sub-issues, links, activity and comments. */
  async issueDetail(ref: IssueRef): Promise<LinearIssueDetail> {
    const workspaceId = this.resolve(ref);
    const data = await this.graphqlIn<{ issue: LinearIssueDetail | null }>(workspaceId, ISSUE_DETAIL_QUERY, { id: ref.id });
    if (!data.issue) throw new Error('Linear no longer has this issue');
    return inWorkspace(data.issue, workspaceId);
  }

  /** What an issue of `teamId` can be set to: states in workflow order, active members, labels, cycles, projects, estimates. */
  async teamOptions(workspaceId: string, teamId: string): Promise<TeamOptions> {
    const cached = this.teamOptionCache.get(teamId);
    if (cached) return cached;
    type Answer = {
      team: {
        cyclesEnabled?: boolean;
        issueEstimationType?: string;
        issueEstimationAllowZero?: boolean;
        issueEstimationExtended?: boolean;
        states: { nodes: LinearState[] };
        members: { nodes: TeamOptions['members'] };
        labels: { nodes: LinearLabel[] };
        cycles?: { nodes: LinearCycle[] };
        projects?: { nodes: TeamOptions['projects'] };
      } | null;
      issueLabels: { nodes: LinearLabel[] };
    };
    const data = await this.graphqlIn<Answer>(workspaceId, TEAM_OPTIONS_QUERY, { id: teamId });
    if (!data.team) throw new Error('Linear no longer has this team');
    const labels = new Map([...data.team.labels.nodes, ...data.issueLabels.nodes].map((label) => [label.id, label]));
    const options: TeamOptions = {
      states: workflowOrder(data.team.states.nodes),
      members: data.team.members.nodes.filter((member) => member.active).sort((a, b) => a.name.localeCompare(b.name)),
      labels: [...labels.values()].sort((a, b) => a.name.localeCompare(b.name)),
      cycles: data.team.cyclesEnabled === false ? [] : [...(data.team.cycles?.nodes ?? [])].sort((a, b) => a.number - b.number),
      projects: [...(data.team.projects?.nodes ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
      estimation: { type: data.team.issueEstimationType ?? 'notUsed', allowZero: Boolean(data.team.issueEstimationAllowZero), extended: Boolean(data.team.issueEstimationExtended) },
    };
    this.teamStates.set(teamId, options.states);
    this.teamOptionCache.set(teamId, options);
    return options;
  }

  /** My user id in a workspace, once known. */
  viewerId(workspaceId: string | null): string | null {
    return workspaceId ? this.viewerIds.get(workspaceId) ?? null : null;
  }

  /** Change fields of an issue in Linear; lists and linked tasks follow. */
  async updateIssue(ref: IssueRef, input: IssueInput): Promise<LinearIssueDetail> {
    const workspaceId = this.resolve(ref);
    const data = await this.graphqlIn<{ issueUpdate: { success: boolean; issue: LinearIssueDetail | null } }>(workspaceId, UPDATE_ISSUE_MUTATION, { id: ref.id, input });
    if (!data.issueUpdate.success || !data.issueUpdate.issue) throw new Error('Linear did not accept the change');
    const issue = inWorkspace(data.issueUpdate.issue, workspaceId);
    await this.issueChanged(issue);
    return issue;
  }

  /**
   * Save an edited title and description. It reads the issue first: if someone
   * changed a field the user also changed since `base`, nothing is written and
   * the current issue comes back as a conflict, unless `force`.
   */
  async saveIssueText(ref: IssueRef, base: IssueText, next: IssueText, force = false): Promise<{ saved: LinearIssueDetail } | { conflict: LinearIssueDetail }> {
    const current = await this.issueDetail(ref);
    const plan = planTextSave(base, { title: current.title, description: current.description ?? '' }, next);
    if (plan.conflict && !force) return { conflict: current };
    if (Object.keys(plan.input).length === 0) return { saved: current };
    return { saved: await this.updateIssue(ref, plan.input) };
  }

  /** Post a Markdown comment on the issue. */
  async addComment(ref: IssueRef, body: string): Promise<LinearComment> {
    const workspaceId = this.resolve(ref);
    const data = await this.graphqlIn<{ commentCreate: { success: boolean; comment: LinearComment | null } }>(workspaceId, ADD_COMMENT_MUTATION, { input: { issueId: ref.id, body } });
    if (!data.commentCreate.success || !data.commentCreate.comment) throw new Error('Linear did not add the comment');
    return data.commentCreate.comment;
  }

  /** The workspace a linked task's issue lives in; older links mean OpenChamber's connection. */
  workspaceOf(source: TaskSourceRef): string | null {
    return source.workspaceId ?? this.hostWorkspace?.id ?? null;
  }

  workspace(id: string | null | undefined): WorkspaceView | null {
    return this.view.workspaces.find((workspace) => workspace.id === id) ?? null;
  }

  answerPrompt(answer: 'yes' | 'no' | 'always'): void {
    const prompt = this.view.prompt;
    this.set({ prompt: null });
    if (!prompt || answer === 'no') return;
    const task = this.client.getView().state.tasks[prompt.taskId];
    if (!task) return;
    if (answer === 'always') {
      void this.client.dispatch([{ type: 'settings.updated', patch: prompt.kind === 'complete' ? { linearOnComplete: 'complete' } : { linearOnPlan: 'start' } }]);
    }
    void this.moveIssue(task, prompt.kind === 'complete' ? 'completed' : 'started');
  }

  /** What filters offer and boards need, for the given workspaces: read once, then kept for a while. */
  loadCatalogs(workspaceIds: readonly string[] = this.scoped().map((workspace) => workspace.id)): Promise<void> {
    return Promise.all(
      workspaceIds
        .filter((workspaceId) => this.workspace(workspaceId))
        .map((workspaceId) => {
          const fresh = Date.now() - (this.catalogTimes.get(workspaceId) ?? 0) < CATALOG_MS && this.view.catalogs[workspaceId];
          if (fresh) return Promise.resolve();
          const running = this.catalogLoads.get(workspaceId);
          if (running) return running;
          const load = this.fetchCatalog(workspaceId)
            .then((catalog) => {
              this.catalogTimes.set(workspaceId, Date.now());
              for (const team of catalog.teams) this.teamStates.set(team.id, workflowOrder(team.states));
              this.set({ catalogs: { ...this.view.catalogs, [workspaceId]: catalog } });
            })
            .catch((error) => console.warn(`[planner] Linear filter choices unavailable: ${messageOf(error)}`))
            .finally(() => this.catalogLoads.delete(workspaceId));
          this.catalogLoads.set(workspaceId, load);
          return load;
        }),
    ).then(() => undefined);
  }

  /** Workflow states of the teams, from the catalogs (for board columns without issues yet). */
  statesForTeams(teamIds: readonly string[]): LinearState[] {
    return teamIds.flatMap((teamId) => this.teamStates.get(teamId) ?? []);
  }

  /** The teams a list is about: a team's view, or the teams of its issues. */
  teamsOf(list: IssueList): string[] {
    const fromView = list.view?.team?.id;
    const own = [...new Set(list.issues.map((issue) => issue.team.id))];
    return fromView ? [...new Set([fromView, ...own])] : own;
  }

  /** The workspaces a list reads. */
  workspacesOf(list: IssueList): string[] {
    return this.targets(list).map((workspace) => workspace.id);
  }

  /** The issues the Linear page shows, in order, so J and K move through them in the issue view. */
  setOrder(refs: IssueRef[]): void {
    this.order = refs;
  }

  /** The issue `delta` places from `ref` in the page's order, if there is one. */
  neighbor(ref: IssueRef, delta: number): IssueRef | null {
    const index = this.order.findIndex((item) => item.id === ref.id);
    if (index < 0) return null;
    return this.order[index + delta] ?? null;
  }

  position(ref: IssueRef): { index: number; total: number } | null {
    const index = this.order.findIndex((item) => item.id === ref.id);
    return index < 0 ? null : { index, total: this.order.length };
  }

  private async moveTo(target: { id: string; key: string; teamId?: string; workspaceId: string | null }, type: string, task: Task | null): Promise<boolean> {
    if (this.view.moving.has(target.id)) return false;
    this.set({ moving: new Set([...this.view.moving, target.id]) });
    try {
      const workspaceId = target.workspaceId;
      if (!workspaceId || !this.workspace(workspaceId)) throw new Error('its Linear workspace is not connected');
      const teamId = target.teamId ?? (await this.issueIn(workspaceId, target.id))?.team.id;
      if (!teamId) throw new Error('the issue was not found');
      const state = stateOfType(await this.statesOf(workspaceId, teamId), type);
      if (!state) throw new Error(`its team has no ${STATE_WORDS[type] ?? type} state`);
      const data = await this.graphqlIn<{ issueUpdate: { success: boolean; issue: LinearIssue | null } }>(workspaceId, SET_STATE_MUTATION, { id: target.id, stateId: state.id });
      if (!data.issueUpdate.success || !data.issueUpdate.issue) throw new Error('Linear did not accept the change');
      const issue = inWorkspace(data.issueUpdate.issue, workspaceId);
      this.replaceIssue(issue);
      if (task) await this.client.dispatch([{ type: 'task.sourceSynced', taskId: task.id, source: issueSource(issue, task.source) }], { origin: 'linear' });
      this.client.notify(`${issue.identifier} is now ${issue.state.name} in Linear`);
      return true;
    } catch (error) {
      this.client.notify(`Couldn't update ${target.key} in Linear: ${messageOf(error)}`);
      return false;
    } finally {
      const moving = new Set(this.view.moving);
      moving.delete(target.id);
      this.set({ moving });
    }
  }

  /** A connected workspace for `ref`, or an error saying it is not. */
  private resolve(ref: IssueRef): string {
    const workspaceId = ref.workspaceId ?? this.hostWorkspace?.id ?? null;
    if (!workspaceId || !this.workspace(workspaceId)) throw new Error('its Linear workspace is not connected');
    return workspaceId;
  }

  /** An edit made here: show it everywhere and bring linked tasks along (not sent back). */
  private async issueChanged(issue: LinearIssueDetail): Promise<void> {
    // Lists keep the light shape (they travel as drag data); the editor keeps the full one.
    const { description: _description, comments: _comments, children: _children, attachments: _attachments, history: _history, ...listed } = issue;
    this.replaceIssue(listed);
    if (this.surface !== 'status') await this.sync({ [issue.id]: listed });
  }

  /** Put a changed issue everywhere it shows; a list it no longer belongs in (its filters, its display) lets it go. */
  private replaceIssue(issue: LinearIssue): void {
    const { state, today } = this.client.getView();
    const context: FilterContext = { today, weekStartsOn: state.settings.weekStartsOn };
    const lists = { ...this.view.lists };
    for (const id of ['page', 'side'] as const) {
      const list = lists[id];
      if (!list.issues.some((item) => item.id === issue.id)) continue;
      const keep = stillListed(issue, list, displayOf(list, state.settings, id), context);
      lists[id] = { ...list, issues: keep ? list.issues.map((item) => (item.id === issue.id ? { ...issue, workspaceId: item.workspaceId ?? issue.workspaceId } : item)) : list.issues.filter((item) => item.id !== issue.id) };
    }
    this.set({ linked: { ...this.view.linked, [issue.id]: issue }, lists });
  }

  private afterCommit(commands: readonly Command[], before: PlannerState, after: PlannerState, origin: Origin): void {
    // Only the user's own changes reach Linear.
    if (origin !== 'user' || !this.available()) return;
    const settings = after.settings;
    const ask = (prompt: LinearPrompt) => {
      // Only surfaces with room for the question ask it.
      if (this.surface !== 'status') this.set({ prompt });
    };
    for (const command of commands) {
      if (command.type === 'task.completed') {
        const task = after.tasks[command.taskId];
        if (task?.source?.kind !== 'linear' || isClosedType(task.source.status?.type)) continue;
        if (settings.linearOnComplete === 'complete') void this.moveIssue(task, 'completed');
        else if (settings.linearOnComplete === 'ask') ask({ kind: 'complete', taskId: task.id, key: task.source.key });
        continue;
      }
      const plannedId = command.type === 'task.created' ? command.task.id : command.type === 'task.moved' ? command.taskId : null;
      if (!plannedId) continue;
      const task = after.tasks[plannedId];
      const previous = before.tasks[plannedId];
      // Only the first time an issue lands on a day, and only while it has not started.
      if (task?.source?.kind !== 'linear' || task.placement.kind !== 'day' || previous?.placement.kind === 'day') continue;
      if (!['backlog', 'unstarted', 'triage'].includes(task.source.status?.type ?? '')) continue;
      if (settings.linearOnPlan === 'start') void this.moveIssue(task, 'started');
      else if (settings.linearOnPlan === 'ask') ask({ kind: 'start', taskId: task.id, key: task.source.key });
    }
  }

  private async sync(linked: Record<string, LinearIssue>): Promise<void> {
    const { state, today } = this.client.getView();
    const bodies = planLinearSync(state, new Map(Object.entries(linked)), { today, importCompletion: state.settings.linearImportCompletion });
    if (bodies.length) await this.client.dispatch(bodies, { origin: 'linear' });
  }

  /** Which workspace OpenChamber's connection reaches, so its issues carry that workspace. */
  private identifyHost(): Promise<boolean> {
    this.identifying ??= (async () => {
      try {
        const data = await this.hostGraphql<{ viewer: { id: string; name: string }; organization: { id: string; name: string; urlKey: string } }>(WHOAMI_QUERY);
        this.viewerIds.set(data.organization.id, data.viewer.id);
        this.set({ connected: true, error: null });
        this.setHost({ id: data.organization.id, name: data.organization.name, urlKey: data.organization.urlKey, account: data.viewer.name, via: 'host', error: null });
        return true;
      } catch (error) {
        // A missing connection shows as Connect, not as an error.
        if (this.view.connected !== false) this.set({ error: messageOf(error) });
        return false;
      } finally {
        this.identifying = null;
      }
    })();
    return this.identifying;
  }

  private setHost(workspace: WorkspaceView | null): void {
    this.hostWorkspace = workspace;
    this.compose();
  }

  private async loadKeyWorkspaces(): Promise<void> {
    try {
      const answer = await this.client.call<{ workspaces: Omit<LinearWorkspace, 'via'>[] }>('GET', '/linear/workspaces');
      this.keyWorkspaces = answer.workspaces.map((workspace) => ({ ...workspace, via: 'key', error: null }));
      this.compose();
    } catch (error) {
      // OpenChamber's own connection works without the service's workspaces.
      console.warn(`[planner] Linear workspaces unavailable: ${messageOf(error)}`);
    }
  }

  /** OpenChamber's workspace first; a key for that same workspace is not needed while it is connected. */
  private compose(): void {
    const errors = new Map(this.view.workspaces.map((workspace) => [workspace.id, workspace.error]));
    const host = this.hostWorkspace;
    const workspaces = [...(host ? [host] : []), ...this.keyWorkspaces.filter((workspace) => workspace.id !== host?.id)].map((workspace) => ({ ...workspace, error: errors.get(workspace.id) ?? null }));
    const scope = this.view.scope === 'all' || workspaces.some((workspace) => workspace.id === this.view.scope) ? this.view.scope : 'all';
    this.set({ workspaces, scope });
  }

  /** Remember which workspaces failed and clear the ones that answered. */
  private noteErrors(errors: ReadonlyMap<string, string>, asked: readonly string[]): void {
    const touched = new Set(asked);
    if (touched.size === 0) return;
    this.set({ workspaces: this.view.workspaces.map((workspace) => (touched.has(workspace.id) ? { ...workspace, error: errors.get(workspace.id) ?? null } : workspace)) });
  }

  /** The shown workspaces: all, or the one chosen. */
  private scoped(): WorkspaceView[] {
    return this.view.scope === 'all' ? this.view.workspaces : this.view.workspaces.filter((workspace) => workspace.id === this.view.scope);
  }

  /** The workspaces a list reads: a view's or project's own, or the shown ones a workspace filter keeps. */
  private targets(list: IssueList): WorkspaceView[] {
    const source = list.source;
    if (source.kind === 'view' || source.kind === 'project') return this.view.workspaces.filter((workspace) => workspace.id === source.workspaceId);
    const shown = this.scoped();
    const kept = new Set(workspacesFor(list.filters, shown.map((workspace) => workspace.id)));
    return shown.filter((workspace) => kept.has(workspace.id));
  }

  private patchList(id: ListId, patch: Partial<IssueList>): void {
    this.set({ lists: { ...this.view.lists, [id]: { ...this.view.lists[id], ...patch } } });
  }

  /**
   * Read a list from its first page: a saved view's display first (it decides
   * which completed issues Linear sends), then pages in every workspace it
   * covers. A refresh reads as many pages as were shown and keeps the display
   * changed meanwhile.
   */
  private async loadList(id: ListId, refreshing = false): Promise<void> {
    if (this.view.connected !== false && !this.hostWorkspace) await this.identifyHost();
    if (!this.available()) return;
    await this.restoring;
    const seq = ++this.listSeq[id];
    let list = this.list(id);
    this.patchList(id, { loading: true, error: null });
    try {
      if (list.source.kind === 'view' && (!list.view || list.view.id !== list.source.id || refreshing)) {
        const meta = await this.viewMeta(list.source.workspaceId, list.source.id);
        if (seq !== this.listSeq[id]) return;
        const fallback = displayOf({ display: null, source: list.source }, this.client.getView().state.settings, id);
        const saved = viewDisplay(meta.viewPreferencesValues, fallback);
        const projects = isProjectView(meta) ? projectViewDisplay(meta.viewPreferencesValues) : null;
        // A view opens as saved; a refresh keeps what was changed since.
        const keep = refreshing && list.view?.id === meta.id;
        this.patchList(id, {
          view: meta,
          display: keep && list.display ? list.display : saved.display,
          projectDisplay: projects ? (keep && list.projectDisplay ? list.projectDisplay : projects.display) : null,
          unsupported: projects ? projects.unsupported : saved.unsupported,
        });
        list = this.list(id);
      }
    } catch (error) {
      if (seq !== this.listSeq[id]) return;
      this.patchList(id, { loading: false, error: messageOf(error), issues: [], projects: null, more: {} });
      return;
    }
    const targets = this.targets(list);
    const maxPages = refreshing ? Math.max(FIRST_PAGES, list.pages) : FIRST_PAGES;
    const settled = await Promise.allSettled(targets.map((workspace) => this.readList(workspace.id, list, id, { maxPages })));
    if (seq !== this.listSeq[id]) return;
    const issues: LinearIssue[] = [];
    const projects: LinearProject[] | null = list.projectDisplay ? [] : null;
    const more: Record<string, string> = {};
    const errors = new Map<string, string>();
    settled.forEach((result, index) => {
      const workspaceId = targets[index]!.id;
      if (result.status === 'rejected') {
        errors.set(workspaceId, messageOf(result.reason));
        return;
      }
      issues.push(...result.value.issues);
      projects?.push(...result.value.projects);
      if (result.value.endCursor) more[workspaceId] = result.value.endCursor;
    });
    this.noteErrors(errors, targets.map((workspace) => workspace.id));
    // A request may have found OpenChamber's connection gone meanwhile; that shows as Connect, not an error.
    const present = targets.filter((workspace) => this.workspace(workspace.id));
    const allFailed = present.length > 0 && present.every((workspace) => errors.has(workspace.id));
    this.patchList(id, { issues, projects, more, pages: maxPages, loading: false, loadingMore: false, error: allFailed ? errors.get(present[0]!.id) ?? null : null });
  }

  /** One workspace's part of a list, from `after` on. */
  private async readList(workspaceId: string, list: IssueList, id: ListId, options: { after?: string | null; maxPages: number }): Promise<{ issues: LinearIssue[]; projects: LinearProject[]; endCursor: string | null }> {
    const source = list.source;
    if (source.kind === 'view' && list.projectDisplay) {
      const filter = projectDisplayFilter(list.projectDisplay);
      const read = await readPages<LinearProject>(async (after) => {
        const data = await this.graphqlIn<{ customView: { projects: Page<LinearProject> } | null }>(workspaceId, VIEW_PROJECTS_QUERY, { id: source.id, after, filter });
        if (!data.customView) throw new Error('Linear no longer has this view');
        return data.customView.projects;
      }, options);
      return { issues: [], projects: read.nodes.map((project) => inWorkspace(project, workspaceId)), endCursor: read.hasMore ? read.endCursor : null };
    }
    const filter = this.serverFilter(list, id);
    const page = (after: string | null): Promise<Page<LinearIssue>> => {
      switch (source.kind) {
        case 'assigned':
          return this.graphqlIn<{ viewer: { id: string; assignedIssues: Page<LinearIssue> } }>(workspaceId, ASSIGNED_QUERY, { after, filter }).then((data) => {
            this.viewerIds.set(workspaceId, data.viewer.id);
            return data.viewer.assignedIssues;
          });
        case 'created':
          return this.graphqlIn<{ viewer: { id: string; createdIssues: Page<LinearIssue> } }>(workspaceId, CREATED_QUERY, { after, filter }).then((data) => {
            this.viewerIds.set(workspaceId, data.viewer.id);
            return data.viewer.createdIssues;
          });
        case 'subscribed':
          return this.graphqlIn<{ issues: Page<LinearIssue> }>(workspaceId, ISSUES_QUERY, { after, filter: allOf({ subscribers: { some: { isMe: { eq: true } } } }, filter) }).then((data) => data.issues);
        case 'project':
          return this.graphqlIn<{ issues: Page<LinearIssue> }>(workspaceId, ISSUES_QUERY, { after, filter: allOf({ project: { id: { eq: source.id } } }, filter) }).then((data) => data.issues);
        case 'view':
          return this.graphqlIn<{ customView: { issues: Page<LinearIssue> } | null }>(workspaceId, VIEW_ISSUES_QUERY, { id: source.id, after, filter }).then((data) => {
            if (!data.customView) throw new Error('Linear no longer has this view');
            return data.customView.issues;
          });
        case 'search':
          return this.graphqlIn<{ searchIssues: Page<LinearIssue> }>(workspaceId, SEARCH_QUERY, { term: source.term, after, filter }).then((data) => data.searchIssues);
      }
    };
    const read = await readPages(page, options);
    return { issues: read.nodes.map((issue) => inWorkspace(issue, workspaceId)), projects: [], endCursor: read.hasMore ? read.endCursor : null };
  }

  /** What a list asks Linear for beyond its own source: what its display hides, and its temporary filters. */
  private serverFilter(list: IssueList, id: ListId): GraphFilter | null {
    const { state, today } = this.client.getView();
    return allOf(displayFilter(displayOf(list, state.settings, id)), compileFilter(list.filters, { today, weekStartsOn: state.settings.weekStartsOn }));
  }

  private async viewMeta(workspaceId: string, id: string): Promise<LinearViewMeta> {
    const data = await this.graphqlIn<{ customView: Omit<LinearViewMeta, 'workspaceId'> | null }>(workspaceId, VIEW_QUERY, { id });
    if (!data.customView) throw new Error('Linear no longer has this view');
    const known = this.view.views.find((view) => view.id === id && view.workspaceId === workspaceId);
    return { ...data.customView, workspaceId, ...(known?.favoriteOrder !== undefined ? { favoriteOrder: known.favoriteOrder } : {}) };
  }

  /** Saved views and favorites of every workspace; optional, My issues works without. */
  private async loadViews(): Promise<void> {
    const workspaces = this.view.workspaces;
    const settled = await Promise.allSettled(workspaces.map((workspace) => this.fetchViewsIn(workspace.id)));
    const views: LinearSavedView[] = [];
    const favorites: LinearFavorite[] = [];
    settled.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;
      views.push(...result.value.views.map((item) => inWorkspace(item, workspaces[index]!.id)));
      favorites.push(...result.value.favorites);
    });
    this.set({ views, favorites, viewsLoaded: true });
  }

  private async fetchViewsIn(workspaceId: string): Promise<{ views: LinearSavedView[]; favorites: LinearFavorite[] }> {
    const favoriteNodes = this.graphqlIn<{ favorites: { nodes: LinearFavoriteNode[] } }>(workspaceId, FAVORITE_VIEWS_QUERY)
      .then((data) => data.favorites.nodes)
      .catch(() => [] as LinearFavoriteNode[]);
    const read = await readPages<LinearSavedView>((after) => this.graphqlIn<{ customViews: Page<LinearSavedView> }>(workspaceId, VIEWS_QUERY, { after }).then((data) => data.customViews), { maxPages: MAX_VIEW_PAGES });
    const nodes = await favoriteNodes;
    const order = favoriteOrder(nodes);
    const known = new Set(read.nodes.map((view) => view.id));
    return {
      views: read.nodes.map((view) => (order.has(view.id) ? { ...view, favoriteOrder: order.get(view.id)! } : view)),
      // A favorite view I can no longer see is left out.
      favorites: favoritesOf(nodes, workspaceId).filter((favorite) => favorite.kind !== 'view' || known.has(favorite.id)),
    };
  }

  private async fetchCatalog(workspaceId: string): Promise<FilterCatalog> {
    const all = <T>(query: string, key: string) =>
      readPages<T>((after) => this.graphqlIn<Record<string, Page<T>>>(workspaceId, query, { after }).then((data) => data[key]!), { maxPages: MAX_CATALOG_PAGES }).then((read) => read.nodes);
    type TeamNode = { id: string; key: string; name: string; states: { nodes: LinearState[] } };
    const [teams, users, labels, projects, cycles] = await Promise.all([
      all<TeamNode>(FILTER_TEAMS_QUERY, 'teams'),
      all<FilterCatalog['users'][number]>(FILTER_USERS_QUERY, 'users').catch(() => []),
      all<FilterCatalog['labels'][number]>(FILTER_LABELS_QUERY, 'issueLabels').catch(() => []),
      all<FilterCatalog['projects'][number]>(FILTER_PROJECTS_QUERY, 'projects').catch(() => []),
      all<FilterCatalog['cycles'][number]>(FILTER_CYCLES_QUERY, 'cycles').catch(() => []),
    ]);
    const me = users.find((user) => user.isMe);
    if (me) this.viewerIds.set(workspaceId, me.id);
    return { workspaceId, teams: teams.map((team) => ({ id: team.id, key: team.key, name: team.name, states: team.states.nodes })), users, labels, projects, cycles };
  }

  /** Issues behind open linked tasks, read from the workspace each lives in. */
  private async fetchLinked(): Promise<{ issues: Record<string, LinearIssue>; errors: Map<string, string>; asked: string[] }> {
    const groups = [...linkedIssueIdsByWorkspace(this.client.getView().state, this.hostWorkspace?.id ?? null)].filter(([workspaceId]) => this.workspace(workspaceId));
    const issues: Record<string, LinearIssue> = {};
    const errors = new Map<string, string>();
    await Promise.all(
      groups.map(async ([workspaceId, ids]) => {
        try {
          for (let index = 0; index < ids.length; index += 100) {
            const data = await this.graphqlIn<{ issues: { nodes: LinearIssue[] } }>(workspaceId, LINKED_QUERY, { ids: ids.slice(index, index + 100) });
            for (const issue of data.issues.nodes) issues[issue.id] = inWorkspace(issue, workspaceId);
          }
        } catch (error) {
          errors.set(workspaceId, messageOf(error));
        }
      }),
    );
    return { issues, errors, asked: groups.map(([workspaceId]) => workspaceId) };
  }

  private async issueIn(workspaceId: string, id: string): Promise<LinearIssue | null> {
    try {
      const issue = (await this.graphqlIn<{ issue: LinearIssue | null }>(workspaceId, ISSUE_QUERY, { id })).issue;
      return issue ? inWorkspace(issue, workspaceId) : null;
    } catch (error) {
      if (/not found/i.test(messageOf(error))) return null;
      throw error;
    }
  }

  private async statesOf(workspaceId: string, teamId: string): Promise<LinearState[]> {
    const cached = this.teamStates.get(teamId);
    if (cached) return cached;
    const data = await this.graphqlIn<{ team: { states: { nodes: LinearState[] } } | null }>(workspaceId, TEAM_STATES_QUERY, { id: teamId });
    const states = workflowOrder(data.team?.states.nodes ?? []);
    this.teamStates.set(teamId, states);
    return states;
  }

  /** Open where the page was last time, on this device. */
  private async restoreLocation(): Promise<void> {
    try {
      const saved = (await this.host.storage.get(LOCATION_KEY, { scope: 'device' })) as Partial<LinearLocation> | undefined;
      if (!saved || !isSource(saved.source)) return;
      const mode: LinearMode = saved.mode === 'projects' || saved.mode === 'planned' ? saved.mode : 'issues';
      const scope = typeof saved.scope === 'string' ? saved.scope : 'all';
      const page = saved.source.kind === 'project' ? emptyList() : emptyList(saved.source);
      this.set({ mode, scope, lists: { ...this.view.lists, page } });
      const project = saved.project;
      if (mode === 'projects' && project && typeof project.id === 'string' && typeof project.workspaceId === 'string') this.pendingProject = project;
    } catch {
      // Device storage is optional (older hosts): the page opens on My issues.
    }
  }

  /** Reopen the project the page showed last time, once its workspace is connected. */
  private reopenProject(): void {
    const pending = this.pendingProject;
    if (!pending || !this.workspace(pending.workspaceId)) return;
    this.pendingProject = null;
    const known = this.view.projects.find((project) => project.id === pending.id && project.workspaceId === pending.workspaceId);
    if (known) void this.openProject(known);
    else {
      void this.graphqlIn<{ project: LinearProjectDetail | null }>(pending.workspaceId, PROJECT_QUERY, { id: pending.id })
        .then((data) => data.project && this.openProject(inWorkspace(data.project, pending.workspaceId)))
        .catch(() => {});
    }
  }

  private saveLocation(): void {
    if (this.surface !== 'page') return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const project = this.view.project?.project;
      const location: LinearLocation = {
        mode: this.view.mode,
        source: this.view.lists.page.source,
        scope: this.view.scope,
        project: project ? { id: project.id, workspaceId: project.workspaceId ?? '' } : null,
      };
      void this.host.storage.set(LOCATION_KEY, location as unknown as Parameters<HostClient['storage']['set']>[1], { scope: 'device' }).catch(() => {});
    }, 300);
  }

  /** Run a document in a workspace: OpenChamber's connection, or the service with that workspace's key. */
  private async graphqlIn<T>(workspaceId: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const workspace = this.workspace(workspaceId);
    if (!workspace) throw new Error('that Linear workspace is not connected');
    if (workspace.via === 'host') return this.hostGraphql<T>(query, variables);
    const answer = await this.client.call<{ status: number; body: string }>('POST', '/linear/graphql', { workspaceId, query, variables });
    if (answer.status === 401) throw new Error(`Linear rejected the API key for ${workspace.name}; add it again in Settings`);
    if (!answer.body) throw new Error(`Linear answered HTTP ${answer.status}`);
    return readGraphql<T>(answer.body);
  }

  private async hostGraphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    try {
      const response = await this.host.request({ method: 'POST', path: '/graphql', body: JSON.stringify({ query, variables }) });
      if (response.status === 401) {
        this.set({ connected: false });
        this.setHost(null);
        throw new Error('Linear needs to be connected again');
      }
      if (!response.body) throw new Error(`Linear answered HTTP ${response.status}`);
      return readGraphql<T>(response.body);
    } catch (error) {
      if (error instanceof HostRequestError && error.code === 'DISCONNECTED') {
        this.set({ connected: false });
        this.setHost(null);
      }
      throw error;
    }
  }

  private set(patch: Partial<LinearView>): void {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }
}

