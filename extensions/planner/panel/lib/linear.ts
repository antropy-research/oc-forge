// Panel-side Linear: issue lists through the host's Linear connection, planning
// issues as tasks, and writing completion back the way Sunsama does (ask, do, or not).
import { HostRequestError, type HostClient } from '@openchamber/sdk';
import type { Command, EventBody } from '../../src/domain/events.ts';
import {
  ASSIGNED_QUERY,
  CREATE_ISSUE_MUTATION,
  ISSUE_QUERY,
  LINKED_QUERY,
  SEARCH_QUERY,
  SET_STATE_MUTATION,
  TEAMS_QUERY,
  TEAM_STATES_QUERY,
  VIEWS_QUERY,
  VIEW_ISSUES_QUERY,
  isClosedType,
  issueSource,
  linkedIssueIds,
  linkedTask,
  planLinearSync,
  priorityToLinear,
  readGraphql,
  stateOfType,
  taskFromIssue,
  type LinearIssue,
  type LinearState,
} from '../../src/domain/linear.ts';
import { edgePosition } from '../../src/domain/selectors.ts';
import { newId } from '../../src/domain/ids.ts';
import type { Placement, PlannerState, Task } from '../../src/domain/types.ts';
import type { Origin, PlannerClient } from './client.ts';

export type LinearSource = { kind: 'assigned' } | { kind: 'view'; id: string } | { kind: 'search'; term: string };

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
}

export interface LinearView {
  /** null until the host or a request says. */
  connected: boolean | null;
  account: string;
  source: LinearSource;
  views: { id: string; name: string }[];
  issues: LinearIssue[];
  /** Current issues behind open linked tasks, by issue id. */
  linked: Record<string, LinearIssue>;
  loading: boolean;
  error: string | null;
  syncedAt: number | null;
  prompt: LinearPrompt | null;
}

const REFRESH_MS = 5 * 60_000;
const MAX_PAGES = 5;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class LinearStore {
  private view: LinearView = {
    connected: null,
    account: '',
    source: { kind: 'assigned' },
    views: [],
    issues: [],
    linked: {},
    loading: false,
    error: null,
    syncedAt: null,
    prompt: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly teamStates = new Map<string, LinearState[]>();
  private teamList: LinearTeam[] | null = null;
  private viewerId: string | null = null;
  private loadSeq = 0;
  private started = false;

  constructor(private readonly host: HostClient, private readonly client: PlannerClient, private readonly surface: string) {}

  getView = (): LinearView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Begin following the connection, refreshing, and answering completed tasks. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.host.onConnection((connection) => {
      const was = this.view.connected;
      this.set({ connected: connection.connected, account: connection.account });
      if (connection.connected && was !== true) void this.refresh(true);
    });
    this.client.onCommitted((commands, before, after, origin) => this.afterCommit(commands, before, after, origin));
    // If the host has not said whether Linear is connected, a request finds out.
    setTimeout(() => {
      if (this.view.connected === null) void this.refresh(true);
    }, 1500);
    setInterval(() => {
      if (this.view.connected && !document.hidden) void this.refresh();
    }, REFRESH_MS);
  }

  connect(): Promise<void> {
    return this.host.oauthStart();
  }

  setSource(source: LinearSource): void {
    this.set({ source, issues: [] });
    void this.refresh();
  }

  /** Reload the current list and the issues behind linked tasks, then sync those tasks. */
  async refresh(withViews = false): Promise<void> {
    if (this.view.connected === false) return;
    const seq = ++this.loadSeq;
    this.set({ loading: true, error: null });
    try {
      const [issues, linked] = await Promise.all([this.fetchList(this.view.source), this.fetchLinked()]);
      if (seq !== this.loadSeq) return;
      this.set({ connected: true, issues, linked, loading: false, syncedAt: Date.now() });
      if (withViews) void this.loadViews();
      // The Work Status frame is a compact control; the page and rail panel keep tasks in sync.
      if (this.surface !== 'status') await this.sync(linked);
    } catch (error) {
      if (seq !== this.loadSeq) return;
      // A request may have found Linear disconnected meanwhile; that shows as Connect, not an error.
      this.set({ loading: false, error: this.getView().connected === false ? null : messageOf(error) });
    }
  }

  /** Commands that plan `issue` at `placement`: move its open task there, or create one. */
  importCommands(issue: LinearIssue, placement: Placement, position?: number): { bodies: EventBody[]; taskId: string } {
    const state = this.client.getView().state;
    const at = position ?? edgePosition(state, placement, 'bottom');
    const existing = linkedTask(state, issue.id);
    if (existing && !existing.completedAt) return { bodies: [{ type: 'task.moved', taskId: existing.id, placement, position: at }], taskId: existing.id };
    const id = newId();
    return { bodies: [{ type: 'task.created', task: taskFromIssue(issue, id, placement, at) }], taskId: id };
  }

  plan(issue: LinearIssue, placement: Placement, position?: number): Promise<void> {
    return this.client.dispatch(this.importCommands(issue, placement, position).bodies, { undo: `Planned ${issue.identifier}` });
  }

  /** An issue by its identifier (NEX-110) or id; null when Linear does not know it. */
  async issue(id: string): Promise<LinearIssue | null> {
    try {
      return (await this.graphql<{ issue: LinearIssue | null }>(ISSUE_QUERY, { id })).issue;
    } catch (error) {
      if (/not found/i.test(messageOf(error))) return null;
      throw error;
    }
  }

  async teams(): Promise<LinearTeam[]> {
    if (this.teamList) return this.teamList;
    const data = await this.graphql<{ viewer: { id: string }; teams: { nodes: LinearTeam[] } }>(TEAMS_QUERY);
    this.viewerId = data.viewer.id;
    this.teamList = data.teams.nodes;
    return this.teamList;
  }

  /** Create an issue from a task, assigned to me, and link the task to it. */
  async createIssue(task: Task, teamId: string): Promise<void> {
    if (!this.viewerId) await this.teams();
    const input: Record<string, unknown> = { teamId, title: task.title, assigneeId: this.viewerId, priority: priorityToLinear(task.priority) };
    if (task.notes.trim()) input.description = task.notes;
    if (task.dueDate) input.dueDate = task.dueDate;
    const data = await this.graphql<{ issueCreate: { success: boolean; issue: LinearIssue | null } }>(CREATE_ISSUE_MUTATION, { input });
    const issue = data.issueCreate.issue;
    if (!data.issueCreate.success || !issue) throw new Error('Linear did not create the issue');
    this.set({ linked: { ...this.view.linked, [issue.id]: issue } });
    await this.client.dispatch([{ type: 'task.updated', taskId: task.id, patch: { source: issueSource(issue) } }]);
    this.client.notify(`Created ${issue.identifier} in Linear`);
  }

  /** Move the issue behind `task` to its team's first completed or started state. */
  async moveIssue(task: Task, type: 'completed' | 'started'): Promise<boolean> {
    const source = task.source;
    if (source?.kind !== 'linear') return false;
    try {
      const teamId = source.teamId ?? (await this.issue(source.id))?.team.id;
      if (!teamId) throw new Error('the issue was not found');
      const target = stateOfType(await this.statesOf(teamId), type);
      if (!target) throw new Error(`its team has no ${type} state`);
      const data = await this.graphql<{ issueUpdate: { success: boolean; issue: LinearIssue | null } }>(SET_STATE_MUTATION, { id: source.id, stateId: target.id });
      const issue = data.issueUpdate.issue;
      if (!data.issueUpdate.success || !issue) throw new Error('Linear did not accept the change');
      this.set({
        linked: { ...this.view.linked, [issue.id]: issue },
        issues: this.view.issues.map((item) => (item.id === issue.id ? issue : item)).filter((item) => !isClosedType(item.state.type)),
      });
      await this.client.dispatch([{ type: 'task.sourceSynced', taskId: task.id, source: issueSource(issue) }], { origin: 'linear' });
      this.client.notify(`${issue.identifier} is now ${issue.state.name} in Linear`);
      return true;
    } catch (error) {
      this.client.notify(`Couldn't update ${source.key} in Linear: ${messageOf(error)}`);
      return false;
    }
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

  private afterCommit(commands: readonly Command[], before: PlannerState, after: PlannerState, origin: Origin): void {
    // Only the user's own changes reach Linear.
    if (origin !== 'user' || this.view.connected === false) return;
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

  private async loadViews(): Promise<void> {
    try {
      const data = await this.graphql<{ customViews: { nodes: { id: string; name: string }[] } }>(VIEWS_QUERY);
      this.set({ views: data.customViews.nodes });
    } catch {
      // Views are optional; My issues still works.
    }
  }

  private async fetchList(source: LinearSource): Promise<LinearIssue[]> {
    if (source.kind === 'view') {
      const data = await this.graphql<{ customView: { issues: { nodes: LinearIssue[] } } | null }>(VIEW_ISSUES_QUERY, { id: source.id });
      return data.customView?.issues.nodes ?? [];
    }
    if (source.kind === 'search') {
      const data = await this.graphql<{ searchIssues: { nodes: LinearIssue[] } }>(SEARCH_QUERY, { term: source.term });
      return data.searchIssues.nodes;
    }
    const issues: LinearIssue[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      type Page = { viewer: { id: string; assignedIssues: { nodes: LinearIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } };
      const data: Page = await this.graphql<Page>(ASSIGNED_QUERY, { after });
      this.viewerId = data.viewer.id;
      issues.push(...data.viewer.assignedIssues.nodes);
      if (!data.viewer.assignedIssues.pageInfo.hasNextPage) break;
      after = data.viewer.assignedIssues.pageInfo.endCursor;
    }
    return issues;
  }

  private async fetchLinked(): Promise<Record<string, LinearIssue>> {
    const ids = linkedIssueIds(this.client.getView().state);
    const out: Record<string, LinearIssue> = {};
    for (let index = 0; index < ids.length; index += 100) {
      const data = await this.graphql<{ issues: { nodes: LinearIssue[] } }>(LINKED_QUERY, { ids: ids.slice(index, index + 100) });
      for (const issue of data.issues.nodes) out[issue.id] = issue;
    }
    return out;
  }

  private async statesOf(teamId: string): Promise<LinearState[]> {
    const cached = this.teamStates.get(teamId);
    if (cached) return cached;
    const data = await this.graphql<{ team: { states: { nodes: LinearState[] } } | null }>(TEAM_STATES_QUERY, { id: teamId });
    const states = data.team?.states.nodes ?? [];
    this.teamStates.set(teamId, states);
    return states;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    try {
      const response = await this.host.request({ method: 'POST', path: '/graphql', body: JSON.stringify({ query, variables }) });
      if (response.status === 401) {
        this.set({ connected: false });
        throw new Error('Linear needs to be connected again');
      }
      if (!response.body) throw new Error(`Linear answered HTTP ${response.status}`);
      return readGraphql<T>(response.body);
    } catch (error) {
      if (error instanceof HostRequestError && error.code === 'DISCONNECTED') this.set({ connected: false });
      throw error;
    }
  }

  private set(patch: Partial<LinearView>): void {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }
}
