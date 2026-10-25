// Panel-side Linear: issue lists and projects from every connected workspace
// (OpenChamber's own Linear connection, plus workspaces added with an API key,
// whose keys the local service keeps), planning issues as tasks, and writing
// completion back the way Sunsama does (ask, do, or not).
import { HostRequestError, type HostClient } from '@openchamber/sdk';
import type { Command, EventBody } from '../../src/domain/events.ts';
import {
  ADD_COMMENT_MUTATION,
  ASSIGNED_QUERY,
  CREATE_ISSUE_MUTATION,
  FAVORITE_VIEWS_QUERY,
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
  WHOAMI_QUERY,
  favoriteOrder,
  githubMirrors,
  inWorkspace,
  isClosedType,
  isIssueView,
  issueSource,
  linkedIssueIdsByWorkspace,
  linkedTask,
  planLinearSync,
  planTextSave,
  priorityToLinear,
  readGraphql,
  stateOfType,
  taskFromIssue,
  viewDisplay,
  workflowOrder,
  type IssueInput,
  type IssueText,
  type LinearComment,
  type LinearFilterRule,
  type LinearIssue,
  type LinearIssueDetail,
  type LinearLabel,
  type LinearProject,
  type LinearProjectDetail,
  type LinearSavedView,
  type LinearState,
  type LinearWorkspace,
  type TeamOptions,
  type ViewDisplay,
} from '../../src/domain/linear.ts';
import { edgePosition } from '../../src/domain/selectors.ts';
import { newId } from '../../src/domain/ids.ts';
import type { Placement, PlannerState, Settings, Task, TaskSourceRef } from '../../src/domain/types.ts';
import type { Origin, PlannerClient } from './client.ts';

export type LinearSource = { kind: 'assigned' } | { kind: 'view'; id: string; workspaceId: string } | { kind: 'search'; term: string };

/** The Linear page's tabs: issues, projects, or the issues already in the plan. */
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
  source: LinearSource;
  /** Saved views of issues, from every connected workspace. */
  views: LinearSavedView[];
  /** Temporary filters on the issue list, as in Linear; a new source starts without any. */
  filters: LinearFilterRule[];
  /**
   * The open view's own layout, grouping and ordering, then any change made
   * while it is open; neither is saved. Null while no view is open.
   */
  viewDisplay: ViewDisplay | null;
  issues: LinearIssue[];
  /** Current issues behind open linked tasks, by issue id. */
  linked: Record<string, LinearIssue>;
  projects: LinearProject[];
  projectsLoaded: boolean;
  projectsLoading: boolean;
  project: OpenProject | null;
  loading: boolean;
  error: string | null;
  syncedAt: number | null;
  prompt: LinearPrompt | null;
  /** Issues with a state change on its way to Linear. */
  moving: ReadonlySet<string>;
}

type Display = Partial<Pick<Settings, 'linearLayout' | 'linearGroupBy' | 'linearOrderBy'>>;

/** The display issue lists use: the settings, or the open view's own. */
export const issueDisplay = (lv: Pick<LinearView, 'mode' | 'source' | 'viewDisplay'>, settings: Settings): Required<Display> => {
  const own = lv.mode === 'issues' && lv.source.kind === 'view' ? lv.viewDisplay ?? {} : {};
  return { linearLayout: settings.linearLayout, linearGroupBy: settings.linearGroupBy, linearOrderBy: settings.linearOrderBy, ...own };
};

const REFRESH_MS = 5 * 60_000;
const MAX_PAGES = 5;
const MAX_PROJECT_PAGES = 4;
const MAX_VIEW_PAGES = 3;
const STATE_WORDS: Record<string, string> = { completed: 'Done', started: 'In Progress', unstarted: 'Todo', backlog: 'Backlog', triage: 'Triage' };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class LinearStore {
  private view: LinearView = {
    connected: null,
    account: '',
    workspaces: [],
    scope: 'all',
    mode: 'issues',
    source: { kind: 'assigned' },
    views: [],
    filters: [],
    viewDisplay: null,
    issues: [],
    linked: {},
    projects: [],
    projectsLoaded: false,
    projectsLoading: false,
    project: null,
    loading: false,
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
  private loadSeq = 0;
  private projectSeq = 0;
  private started = false;
  /** The view whose saved display `viewDisplay` was set from; a refresh keeps changes made since. */
  private viewDisplayFor: string | null = null;

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

  /** Show another list; like opening another view in Linear, it starts without temporary filters. */
  setSource(source: LinearSource): void {
    this.viewDisplayFor = null;
    this.set({ source, issues: [], filters: [], viewDisplay: null });
    void this.refresh();
  }

  setFilters(filters: LinearFilterRule[]): void {
    this.set({ filters: filters.filter((rule) => rule.values.length > 0) });
  }

  setMode(mode: LinearMode): void {
    this.set({ mode });
    if (mode === 'projects' && !this.view.projectsLoaded && !this.view.projectsLoading) void this.loadProjects();
  }

  /** Show one workspace, or all of them merged. */
  setScope(scope: string): void {
    const source = this.view.source.kind === 'view' && scope !== 'all' && this.view.source.workspaceId !== scope ? { kind: 'assigned' as const } : this.view.source;
    this.set({ scope, source, issues: [], projects: [], projectsLoaded: false, project: null });
    void this.refresh();
    if (this.view.mode === 'projects') void this.loadProjects();
  }

  /** Change the display: of the open view only, for now, as in Linear; otherwise in the settings. */
  setDisplay(patch: Display): Promise<void> {
    if (this.view.mode === 'issues' && this.view.source.kind === 'view') {
      this.set({ viewDisplay: { ...this.view.viewDisplay, ...patch } });
      return Promise.resolve();
    }
    return this.client.dispatch([{ type: 'settings.updated', patch }]);
  }

  /** Reload the current list and the issues behind linked tasks, then sync those tasks. */
  async refresh(withViews = false): Promise<void> {
    if (this.view.connected !== false && !this.hostWorkspace) await this.identifyHost();
    if (!this.available()) return;
    const seq = ++this.loadSeq;
    this.set({ loading: true, error: null });
    const source = this.view.source;
    const targets = this.targets(source);
    const [list, linked] = await Promise.all([this.fetchList(source, targets), this.fetchLinked()]);
    if (seq !== this.loadSeq) return;
    this.noteErrors(new Map([...linked.errors, ...list.errors]), [...targets.map((workspace) => workspace.id), ...linked.asked]);
    // A request may have found OpenChamber's connection gone meanwhile; that shows as Connect, not an error.
    const present = targets.filter((workspace) => this.workspace(workspace.id));
    const allFailed = present.length > 0 && present.every((workspace) => list.errors.has(workspace.id));
    // A view opens the way it was saved in Linear; later refreshes keep what was changed since.
    const viewKey = source.kind === 'view' ? `${source.workspaceId}:${source.id}` : null;
    const display = viewKey && list.display && this.viewDisplayFor !== viewKey ? { viewDisplay: list.display } : {};
    if (viewKey && list.display) this.viewDisplayFor = viewKey;
    this.set({ issues: list.issues, linked: linked.issues, loading: false, syncedAt: Date.now(), error: allFailed ? list.errors.get(present[0]!.id) ?? null : null, ...display });
    if (withViews) void this.loadViews();
    // The Work Status frame is a compact control; the page and rail panel keep tasks in sync.
    if (this.surface !== 'status') await this.sync(linked.issues);
  }

  /** Projects of the shown workspaces that are not completed or canceled. */
  async loadProjects(): Promise<void> {
    if (this.view.connected !== false && !this.hostWorkspace) await this.identifyHost();
    if (!this.available()) return;
    const seq = ++this.projectSeq;
    const targets = this.targets({ kind: 'assigned' });
    this.set({ projectsLoading: true });
    const settled = await Promise.allSettled(targets.map((workspace) => this.fetchProjectsIn(workspace.id)));
    if (seq !== this.projectSeq) return;
    const errors = new Map<string, string>();
    const projects: LinearProject[] = [];
    settled.forEach((result, index) => {
      const workspaceId = targets[index]!.id;
      if (result.status === 'fulfilled') projects.push(...result.value.map((project) => inWorkspace(project, workspaceId)));
      else errors.set(workspaceId, messageOf(result.reason));
    });
    this.noteErrors(errors, targets.map((workspace) => workspace.id));
    const allFailed = targets.length > 0 && errors.size === targets.length;
    this.set({ projects, projectsLoaded: true, projectsLoading: false, ...(allFailed ? { error: errors.get(targets[0]!.id) ?? null } : {}) });
  }

  /** Open a project: its overview, milestones, latest update and open issues. */
  async openProject(project: LinearProject): Promise<void> {
    this.set({ project: { project, detail: null, loading: true, error: null } });
    const workspaceId = project.workspaceId ?? '';
    try {
      const data = await this.graphqlIn<{ project: LinearProjectDetail | null }>(workspaceId, PROJECT_QUERY, { id: project.id });
      if (this.view.project?.project.id !== project.id) return;
      if (!data.project) throw new Error('Linear no longer has this project');
      const detail = { ...inWorkspace(data.project, workspaceId), issues: { nodes: data.project.issues.nodes.map((issue) => inWorkspace(issue, workspaceId)) } };
      this.set({ project: { project, detail, loading: false, error: null } });
    } catch (error) {
      if (this.view.project?.project.id !== project.id) return;
      this.set({ project: { project, detail: null, loading: false, error: messageOf(error) } });
    }
  }

  closeProject(): void {
    this.set({ project: null });
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
    this.set({
      issues: keep(this.view.issues),
      views: keep(this.view.views),
      projects: keep(this.view.projects),
      linked: Object.fromEntries(Object.entries(this.view.linked).filter(([, issue]) => issue.workspaceId !== id)),
      project: this.view.project?.project.workspaceId === id ? null : this.view.project,
      source: this.view.source.kind === 'view' && this.view.source.workspaceId === id ? { kind: 'assigned' } : this.view.source,
    });
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

  /** A board drop: move the issue to its team's first state of `type`. */
  moveIssueToType(issue: LinearIssue, type: string): Promise<boolean> {
    if (!type || issue.state.type === type) return Promise.resolve(false);
    const task = linkedTask(this.client.getView().state, issue.id);
    return this.moveTo({ id: issue.id, key: issue.identifier, teamId: issue.team.id, workspaceId: issue.workspaceId ?? this.hostWorkspace?.id ?? null }, type, task && !task.completedAt ? task : null);
  }

  /** The issue with its Markdown description, labels and comments. */
  async issueDetail(ref: IssueRef): Promise<LinearIssueDetail> {
    const workspaceId = this.resolve(ref);
    const data = await this.graphqlIn<{ issue: LinearIssueDetail | null }>(workspaceId, ISSUE_DETAIL_QUERY, { id: ref.id });
    if (!data.issue) throw new Error('Linear no longer has this issue');
    return inWorkspace(data.issue, workspaceId);
  }

  /** What an issue of `teamId` can be set to: states in workflow order, active members, labels. */
  async teamOptions(workspaceId: string, teamId: string): Promise<TeamOptions> {
    const cached = this.teamOptionCache.get(teamId);
    if (cached) return cached;
    type Answer = {
      team: { states: { nodes: LinearState[] }; members: { nodes: TeamOptions['members'] }; labels: { nodes: LinearLabel[] } } | null;
      issueLabels: { nodes: LinearLabel[] };
    };
    const data = await this.graphqlIn<Answer>(workspaceId, TEAM_OPTIONS_QUERY, { id: teamId });
    if (!data.team) throw new Error('Linear no longer has this team');
    const labels = new Map([...data.team.labels.nodes, ...data.issueLabels.nodes].map((label) => [label.id, label]));
    const options: TeamOptions = {
      states: workflowOrder(data.team.states.nodes),
      members: data.team.members.nodes.filter((member) => member.active).sort((a, b) => a.name.localeCompare(b.name)),
      labels: [...labels.values()].sort((a, b) => a.name.localeCompare(b.name)),
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
    const { description: _description, comments: _comments, ...listed } = issue;
    this.replaceIssue(listed);
    if (this.surface !== 'status') await this.sync({ [issue.id]: listed });
  }

  /** Put a changed issue everywhere it shows; a closed one leaves the open lists. */
  private replaceIssue(issue: LinearIssue): void {
    const swap = (list: LinearIssue[]) => list.map((item) => (item.id === issue.id ? issue : item)).filter((item) => !isClosedType(item.state.type));
    const open = this.view.project;
    this.set({
      linked: { ...this.view.linked, [issue.id]: issue },
      issues: swap(this.view.issues),
      project: open?.detail ? { ...open, detail: { ...open.detail, issues: { nodes: swap(open.detail.issues.nodes) } } } : open,
    });
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
        this.set({ connected: true });
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

  /** The workspaces a list reads: a view's own, or the shown ones. */
  private targets(source: LinearSource): WorkspaceView[] {
    if (source.kind === 'view') return this.view.workspaces.filter((workspace) => workspace.id === source.workspaceId);
    if (this.view.scope === 'all') return this.view.workspaces;
    return this.view.workspaces.filter((workspace) => workspace.id === this.view.scope);
  }

  /** Saved views of issues in every workspace, with my favorites marked; optional, My issues works without. */
  private async loadViews(): Promise<void> {
    const workspaces = this.view.workspaces;
    const settled = await Promise.allSettled(workspaces.map((workspace) => this.fetchViewsIn(workspace.id)));
    this.set({ views: settled.flatMap((result, index) => (result.status === 'fulfilled' ? result.value.map((item) => inWorkspace(item, workspaces[index]!.id)) : [])) });
  }

  private async fetchViewsIn(workspaceId: string): Promise<LinearSavedView[]> {
    const favorites = this.graphqlIn<{ favorites: { nodes: { type: string; sortOrder: number; customView: { id: string } | null }[] } }>(workspaceId, FAVORITE_VIEWS_QUERY)
      .then((data) => favoriteOrder(data.favorites.nodes))
      .catch(() => new Map<string, number>());
    const views: LinearSavedView[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_VIEW_PAGES; page++) {
      type Page = { customViews: { nodes: LinearSavedView[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
      const data: Page = await this.graphqlIn<Page>(workspaceId, VIEWS_QUERY, { after });
      views.push(...data.customViews.nodes);
      if (!data.customViews.pageInfo.hasNextPage) break;
      after = data.customViews.pageInfo.endCursor;
    }
    const order = await favorites;
    return views.filter(isIssueView).map((view) => (order.has(view.id) ? { ...view, favoriteOrder: order.get(view.id)! } : view));
  }

  private async fetchList(source: LinearSource, targets: readonly WorkspaceView[]): Promise<{ issues: LinearIssue[]; errors: Map<string, string>; display: ViewDisplay | null }> {
    const settled = await Promise.allSettled(targets.map((workspace) => this.fetchListIn(workspace.id, source)));
    const issues: LinearIssue[] = [];
    const errors = new Map<string, string>();
    let display: ViewDisplay | null = null;
    settled.forEach((result, index) => {
      const workspaceId = targets[index]!.id;
      if (result.status === 'fulfilled') {
        issues.push(...result.value.issues.map((issue) => inWorkspace(issue, workspaceId)));
        display ??= result.value.display ?? null;
      } else errors.set(workspaceId, messageOf(result.reason));
    });
    return { issues, errors, display };
  }

  private async fetchListIn(workspaceId: string, source: LinearSource): Promise<{ issues: LinearIssue[]; display?: ViewDisplay }> {
    if (source.kind === 'view') {
      const issues: LinearIssue[] = [];
      let display: ViewDisplay = {};
      let after: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        type Page = {
          customView: {
            viewPreferencesValues: { layout: string | null; issueGrouping: string | null; viewOrdering: string | null } | null;
            issues: { nodes: LinearIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
          } | null;
        };
        const data: Page = await this.graphqlIn<Page>(workspaceId, VIEW_ISSUES_QUERY, { id: source.id, after });
        if (!data.customView) throw new Error('Linear no longer has this view');
        if (page === 0) display = viewDisplay(data.customView.viewPreferencesValues);
        issues.push(...data.customView.issues.nodes);
        if (!data.customView.issues.pageInfo.hasNextPage) break;
        after = data.customView.issues.pageInfo.endCursor;
      }
      return { issues, display };
    }
    if (source.kind === 'search') {
      const data = await this.graphqlIn<{ searchIssues: { nodes: LinearIssue[] } }>(workspaceId, SEARCH_QUERY, { term: source.term });
      return { issues: data.searchIssues.nodes };
    }
    const issues: LinearIssue[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      type Page = { viewer: { id: string; assignedIssues: { nodes: LinearIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } };
      const data: Page = await this.graphqlIn<Page>(workspaceId, ASSIGNED_QUERY, { after });
      this.viewerIds.set(workspaceId, data.viewer.id);
      issues.push(...data.viewer.assignedIssues.nodes);
      if (!data.viewer.assignedIssues.pageInfo.hasNextPage) break;
      after = data.viewer.assignedIssues.pageInfo.endCursor;
    }
    return { issues };
  }

  private async fetchProjectsIn(workspaceId: string): Promise<LinearProject[]> {
    const projects: LinearProject[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
      type Page = { projects: { nodes: LinearProject[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
      const data: Page = await this.graphqlIn<Page>(workspaceId, PROJECTS_QUERY, { after });
      projects.push(...data.projects.nodes);
      if (!data.projects.pageInfo.hasNextPage) break;
      after = data.projects.pageInfo.endCursor;
    }
    return projects;
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
    const states = data.team?.states.nodes ?? [];
    this.teamStates.set(teamId, states);
    return states;
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
