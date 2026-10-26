// Agents on tasks: start OpenChamber sessions for tasks, follow their live state,
// and keep the run facts (adopted runs, settled outcomes) in the Planner's log.
import type { GuestProject, GuestSessionRecord, GuestSessionsSnapshot, GuestWorktree, HostClient } from '@openchamber/sdk';
import { needsYou, planAdoptions, planRunOutcomes, runStatus, taskChipId, taskUrl, type LiveSession } from '../../src/domain/runs.ts';
import { newId } from '../../src/domain/ids.ts';
import type { PlannerState, TaskRun } from '../../src/domain/types.ts';
import type { PlannerClient } from './client.ts';

export const PANEL_ID = 'oc-forge-planner';
/** The host allows 32 subscriptions per frame; projects and their sessions share them. */
const MAX_WATCHED_PROJECTS = 24;
const ATTACH_TEXT_MAX = 16_000;

export type WorkspaceChoice = { kind: 'project' } | { kind: 'new'; branch: string } | { kind: 'existing'; directory: string };

export interface DispatchChoice {
  projectId: string;
  workspace: WorkspaceChoice;
  prompt: string;
  /** Open the new chat; otherwise stay in the Planner. */
  open: boolean;
}

export interface AgentView {
  /** False when the host refuses workspace access (capability not approved). */
  available: boolean | null;
  projects: GuestProject[];
  /** Sessions of the watched projects, by session id. */
  sessions: ReadonlyMap<string, LiveSession>;
  /** Tasks with a start in flight; a second start waits for the first. */
  dispatching: ReadonlySet<string>;
  /** Tasks whose agents wait on the user. */
  attention: number;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const toLive = (record: GuestSessionRecord): LiveSession => ({
  id: record.id,
  title: record.title,
  projectId: record.projectId,
  directory: record.directory,
  activity: record.activity,
  outcome: record.outcome,
  updatedAt: record.updatedAt,
  archivedAt: record.archivedAt,
  worktree: record.worktree ? { directory: record.worktree.directory, branch: record.worktree.branch } : null,
  items: record.items,
});

/** A branch name from a task title; non-Latin titles fall back to the task id. */
export const branchFor = (title: string, taskId: string): string => {
  const slug = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `planner/${slug.length >= 3 ? slug : `task-${taskId.slice(-6)}`}`;
};

export class AgentStore {
  private view: AgentView = { available: null, projects: [], sessions: new Map(), dispatching: new Set(), attention: 0 };
  private readonly listeners = new Set<() => void>();
  private readonly watched = new Map<string, () => void>();
  private readonly byProject = new Map<string, LiveSession[]>();
  private directory: string | null = null;
  private started = false;
  private recording = false;
  private lastBadge: number | null = null;

  constructor(private readonly host: HostClient, private readonly client: PlannerClient, private readonly surface: string) {}

  getView = (): AgentView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async start(): Promise<void> {
    if (this.started || this.surface === 'background') return;
    this.started = true;
    this.host.onDirectory((directory) => {
      this.directory = directory;
      void this.watchNeeded();
    });
    this.client.onCommitted(() => {
      void this.watchNeeded();
      this.refreshAttention();
    });
    try {
      await this.host.onProjects((snapshot) => {
        this.set({ projects: snapshot.projects, available: true });
        void this.watchNeeded();
      });
    } catch (error) {
      console.warn(`[planner] project list unavailable: ${messageOf(error)}`);
      this.set({ available: false });
    }
  }

  /** The registered project a run belongs to. */
  projectOf(run: Pick<TaskRun, 'projectId' | 'directory'>): GuestProject | null {
    if (run.projectId) {
      const byId = this.view.projects.find((project) => project.id === run.projectId);
      if (byId) return byId;
    }
    return run.directory ? this.view.projects.find((project) => project.directory === run.directory) ?? null : null;
  }

  /** The project to suggest for a new run: the task's last one, else the open project, else the first. */
  defaultProject(state: PlannerState, taskId: string): GuestProject | null {
    const runs = Object.values(state.runs).filter((run) => run.taskId === taskId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const run of runs) {
      const project = this.projectOf(run);
      if (project) return project;
    }
    return this.view.projects.find((project) => project.directory === this.directory) ?? this.view.projects[0] ?? null;
  }

  async worktrees(projectId: string): Promise<GuestWorktree[]> {
    const snapshot = await this.host.listWorktrees(projectId);
    return snapshot.worktrees.filter((worktree) => worktree.status === 'ready');
  }

  openSession(sessionId: string): Promise<void> {
    return this.host.openSession(sessionId);
  }

  /**
   * Start an agent session for a task, optionally in a worktree, with the task
   * attached as a chip that carries the run id. Returns whether a run started.
   */
  async dispatch(taskId: string, choice: DispatchChoice): Promise<boolean> {
    if (this.view.dispatching.has(taskId)) return false;
    const state = this.client.getView().state;
    const task = state.tasks[taskId];
    if (!task) return false;
    this.set({ dispatching: new Set([...this.view.dispatching, taskId]) });
    const runId = newId();
    try {
      const workspace = choice.workspace;
      const result = await this.host.startSession({
        providerId: PANEL_ID,
        id: taskChipId(state, task.id),
        title: task.title.slice(0, 200),
        url: taskUrl(state, task.id),
        text: (choice.prompt.trim() || task.title).slice(0, ATTACH_TEXT_MAX),
        data: { taskId: task.id, runId },
        projectId: choice.projectId,
        navigation: choice.open ? 'open' : 'preserve',
        worktree: workspace.kind === 'project' ? false : workspace.kind === 'new' ? { kind: 'new', ...(workspace.branch.trim() ? { name: workspace.branch.trim() } : {}) } : { kind: 'existing', directory: workspace.directory },
      });
      if (result.sessionId === null) {
        this.client.notify(`OpenChamber made worktree ${result.worktree.branch} but could not start the chat (${result.failure}). Start again with that existing worktree.`);
        return false;
      }
      const project = this.view.projects.find((item) => item.id === choice.projectId);
      await this.client.dispatch([
        {
          type: 'run.started',
          run: {
            id: runId,
            taskId: task.id,
            sessionId: result.sessionId,
            projectId: choice.projectId,
            directory: result.directory ?? project?.directory ?? null,
            worktree: result.worktree ? { directory: result.worktree.directory, branch: result.worktree.branch } : null,
            title: task.title,
          },
        },
      ]);
      void this.watch(choice.projectId);
      if (result.sent === 'no-model') this.client.notify('The chat was created, but no model is set up to answer it. Open the chat to pick one.');
      else if (result.sent === 'failed') this.client.notify('The chat was created, but the first message did not send. Open the chat to send it again.');
      else this.client.notify(`Agent started on "${task.title}"`);
      return true;
    } catch (error) {
      this.client.notify(`Could not start the agent: ${messageOf(error)}`);
      return false;
    } finally {
      const next = new Set(this.view.dispatching);
      next.delete(taskId);
      this.set({ dispatching: next });
    }
  }

  /** Watch the projects that runs belong to, plus the open project (for adoption). */
  private async watchNeeded(): Promise<void> {
    const wanted = new Set<string>();
    for (const run of Object.values(this.client.getView().state.runs)) {
      const project = this.projectOf(run);
      if (project) wanted.add(project.id);
    }
    const open = this.view.projects.find((project) => project.directory === this.directory);
    if (open) wanted.add(open.id);
    for (const projectId of wanted) await this.watch(projectId);
  }

  private async watch(projectId: string): Promise<void> {
    if (this.watched.has(projectId) || this.watched.size >= MAX_WATCHED_PROJECTS) return;
    this.watched.set(projectId, () => {});
    try {
      const stop = await this.host.onSessions(projectId, (snapshot) => this.onSessions(snapshot));
      this.watched.set(projectId, stop);
    } catch (error) {
      this.watched.delete(projectId);
      console.warn(`[planner] cannot follow sessions of ${projectId}: ${messageOf(error)}`);
    }
  }

  private onSessions(snapshot: GuestSessionsSnapshot): void {
    // A loading or failed snapshot may hold partial data; keep what we had for that project.
    if (snapshot.state !== 'ready' && snapshot.sessions.length === 0) return;
    this.byProject.set(snapshot.projectId, snapshot.sessions.map(toLive));
    const sessions = new Map<string, LiveSession>();
    for (const list of this.byProject.values()) for (const session of list) sessions.set(session.id, session);
    this.set({ sessions });
    this.refreshAttention();
    void this.record();
  }

  /** Write down adopted runs and settled outcomes; quiet, since another surface may do the same. */
  private async record(): Promise<void> {
    if (this.recording) return;
    const state = this.client.getView().state;
    if (!this.client.getView().loaded) return;
    const bodies = [...planAdoptions(state, this.view.sessions.values()), ...planRunOutcomes(state, this.view.sessions)];
    if (bodies.length === 0) return;
    this.recording = true;
    try {
      await this.client.dispatch(bodies, { origin: 'agent' });
    } finally {
      this.recording = false;
    }
  }

  private refreshAttention(): void {
    const state = this.client.getView().state;
    const tasks = new Set<string>();
    for (const run of Object.values(state.runs)) {
      const task = state.tasks[run.taskId];
      if (!task || task.deletedAt) continue;
      if (needsYou(runStatus(run, this.view.sessions.get(run.sessionId)))) tasks.add(run.taskId);
    }
    if (tasks.size !== this.view.attention) this.set({ attention: tasks.size });
    // The rail icon counts tasks whose agents wait on you; an open rail panel clears it anyway.
    const badge = tasks.size || null;
    if (badge !== this.lastBadge && this.surface !== 'panel') {
      this.lastBadge = badge;
      void this.host.setBadge(badge).catch(() => {});
    }
  }

  private set(patch: Partial<AgentView>): void {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }
}
