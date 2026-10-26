// Agents on tasks: start OpenChamber sessions for tasks, follow their live state,
// and keep the run facts (adopted runs, settled outcomes) in the Planner's log.
import type { GuestProject, GuestSessionRecord, GuestSessionsSnapshot, GuestWorktree, HostClient } from '@openchamber/sdk';
import { assignPrompt, needsYou, planAdoptions, planLinkedPullRequests, planPullRequests, planRunOutcomes, pullRequestLookups, runStatus, runsFor, taskChipId, taskUrl, type LiveSession } from '../../src/domain/runs.ts';
import { commandText, type AgentCatalog } from '../../src/domain/assignees.ts';
import type { SeenPullRequest } from '../../src/domain/events.ts';
import { newId } from '../../src/domain/ids.ts';
import type { PlannerState, RunAssignee, TaskRun } from '../../src/domain/types.ts';
import type { PlannerClient } from './client.ts';

export const PANEL_ID = 'oc-forge-planner';
/** The host allows 32 subscriptions per frame; projects and their sessions share them. */
const MAX_WATCHED_PROJECTS = 24;
const ATTACH_TEXT_MAX = 16_000;
const PR_REFRESH_MS = 2 * 60_000;
/** The service answers four lookups per request, so each request stays short. */
const PR_BATCH = 4;
/** OpenCode reloads its commands 100 ms after a file changes; when it cannot be asked whether it did, wait this long. */
const COMMAND_SETTLE_MS = 1500;
/**
 * A folder OpenCode has just started serving lists no commands for about
 * 100 ms (measured with OpenCode 2.1.4), and OpenChamber 2.5.2 sends a new
 * chat's first message within that time; this is how long a new worktree gets.
 */
const LOCATION_SETTLE_MS = 1500;
const WORKTREE_WAIT_MS = 15_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type WorkspaceChoice = { kind: 'project' } | { kind: 'new'; branch: string } | { kind: 'existing'; directory: string };

export interface DispatchChoice {
  projectId: string;
  workspace: WorkspaceChoice;
  prompt: string;
  /** Open the new chat; otherwise stay in the Planner. */
  open: boolean;
  /** Assigned, as in GitHub or Linear: the agent is to open a pull request, which the Planner then follows. */
  wantsPr?: boolean;
  /** The agent and model to start the chat as, through its command; none takes OpenChamber's defaults. */
  assignee?: RunAssignee | null;
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
  /** Why the last pull request lookup failed (no gh, not logged in), until one works. */
  prError: string | null;
  /** The agents and models to assign to, as the service found them; null until asked. */
  catalog: AgentCatalog | null;
  catalogLoading: boolean;
  catalogError: string | null;
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
  ...(record.links ? { links: record.links.map((link) => ({ title: link.title, url: link.url, kind: link.kind })) } : {}),
});

/** A branch name from a task title; non-Latin titles fall back to the task id. */
export const branchFor = (title: string, taskId: string): string => {
  const slug = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `planner/${slug.length >= 3 ? slug : `task-${taskId.slice(-6)}`}`;
};

/** A branch for a new assignment: Linear's name for the issue, else from the title; a number on the end when an earlier run of the task used it. */
export const assignBranch = (state: PlannerState, taskId: string): string => {
  const task = state.tasks[taskId];
  if (!task) return 'planner/task';
  const base = (task.source?.kind === 'linear' && task.source.branch) || branchFor(task.title, task.id);
  const used = new Set(runsFor(state, taskId).flatMap((run) => (run.worktree?.branch ? [run.worktree.branch] : [])));
  let branch = base;
  for (let n = 2; used.has(branch); n++) branch = `${base}-${n}`;
  return branch;
};

export class AgentStore {
  private view: AgentView = { available: null, projects: [], sessions: new Map(), dispatching: new Set(), attention: 0, prError: null, catalog: null, catalogLoading: false, catalogError: null };
  private catalogFor: string | null | undefined = undefined;
  private lookingUp = false;
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
    // Pull requests open, merge and close on GitHub; look again now and then.
    setTimeout(() => void this.refreshPullRequests(), 3000);
    setInterval(() => {
      if (!document.hidden) void this.refreshPullRequests();
    }, PR_REFRESH_MS);
  }

  /**
   * Look up the pull requests of runs that have a worktree branch, through gh on
   * the machine running OpenChamber, and write down the ones that changed.
   */
  async refreshPullRequests(): Promise<void> {
    if (this.lookingUp || !this.client.getView().loaded) return;
    const lookups = pullRequestLookups(this.client.getView().state);
    if (lookups.length === 0) return;
    this.lookingUp = true;
    try {
      const found = new Map<string, SeenPullRequest>();
      let error: string | null = null;
      for (let index = 0; index < lookups.length; index += PR_BATCH) {
        type Answer = { results: { runId: string; pullRequest: SeenPullRequest | null; error?: string }[] };
        const answer = await this.client.call<Answer>('POST', '/github/pulls', { runs: lookups.slice(index, index + PR_BATCH) });
        for (const result of answer.results) {
          if (result.pullRequest) found.set(result.runId, result.pullRequest);
          else if (result.error) error = result.error;
        }
      }
      this.set({ prError: error });
      // Another surface may have written the same change meanwhile; compare with the latest state.
      const bodies = planPullRequests(this.client.getView().state, found);
      if (bodies.length) await this.client.dispatch(bodies, { origin: 'agent' });
    } catch (error) {
      this.set({ prError: messageOf(error) });
    } finally {
      this.lookingUp = false;
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
   * The agents and models to assign to, from the service (which asks OpenCode),
   * with the project folder's own agents. Kept until another folder or a refresh is asked for.
   */
  async loadCatalog(directory: string | null = null, refresh = false, again = false): Promise<void> {
    if (!refresh && !again && this.catalogFor === directory && (this.view.catalog || this.view.catalogLoading)) return;
    this.catalogFor = directory;
    this.set({ catalogLoading: true });
    try {
      const query = [directory ? `directory=${encodeURIComponent(directory)}` : '', refresh ? 'refresh=1' : ''].filter(Boolean).join('&');
      const catalog = await this.client.call<AgentCatalog>('GET', `/agents${query ? `?${query}` : ''}`);
      if (this.catalogFor === directory) this.set({ catalog, catalogLoading: false, catalogError: null });
      // The agents are here; the models follow once OpenCode has listed them.
      if (catalog.modelsPending && this.catalogFor === directory) setTimeout(() => void this.loadCatalog(directory, false, true), 2500);
    } catch (error) {
      if (this.catalogFor === directory) this.set({ catalogLoading: false, catalogError: messageOf(error) });
    }
  }

  /**
   * Assign a task, as in GitHub or Linear: `assignee` works on it in a new
   * worktree (Linear's branch name, else from the title) of the task's project
   * and opens a pull request. Returns whether a run started.
   */
  assign(taskId: string, assignee: RunAssignee | null, projectId?: string | null): Promise<boolean> {
    const state = this.client.getView().state;
    const project = (projectId ? this.view.projects.find((item) => item.id === projectId) : null) ?? this.defaultProject(state, taskId);
    if (!state.tasks[taskId]) return Promise.resolve(false);
    if (!project) {
      this.client.notify(this.view.available === false ? 'OpenChamber did not allow the Planner to see projects. Approve its access in Settings → Extensions.' : 'Add a project in OpenChamber first; agents work inside a project.');
      return Promise.resolve(false);
    }
    const branch = assignBranch(state, taskId);
    return this.dispatch(taskId, { projectId: project.id, workspace: { kind: 'new', branch }, prompt: assignPrompt(state, taskId, branch), open: false, wantsPr: true, assignee });
  }

  /**
   * The command that starts a chat as `assignee`, written by the service and
   * listed by OpenCode before the chat starts: asked twice, then given up on,
   * since an unknown command would reach the agent as plain text.
   */
  private async commandFor(assignee: RunAssignee, directory: string | null): Promise<string> {
    const presets = this.client.getView().state.settings.agentPresets ?? [];
    const entry = { assignee, kind: presets.some((preset) => preset.id === assignee.id) ? 'preset' : 'agent' };
    type Answer = { commands: { name: string; changed: boolean }[]; listed: boolean | null; dir: string };
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = await this.client.call<Answer>('POST', '/agents/commands', { entries: [entry], directory, wait: true });
      const command = answer.commands[0];
      if (!command) throw new Error('the service wrote no command');
      if (answer.listed === true) return command.name;
      // OpenCode's server cannot be asked: give a new file the time OpenCode takes to read it.
      if (answer.listed === null) {
        if (command.changed) await sleep(COMMAND_SETTLE_MS);
        return command.name;
      }
      if (attempt === 1) throw new Error(`OpenCode does not list /${command.name} yet. Is its config folder ${answer.dir.replace(/\/command$/, '')}?`);
    }
    throw new Error('unreachable');
  }

  /**
   * Make a new worktree for an assignee's chat before the chat starts, and
   * return its folder. OpenChamber makes it with a chat that has no message
   * ("Worktree for …"), which starts OpenCode there; once OpenChamber lists the
   * worktree and OpenCode has had time to load its commands, the agent's chat
   * starts in it and its first message reaches the command.
   */
  private async prepareWorktree(taskId: string, runId: string, projectId: string, branch: string): Promise<string> {
    const state = this.client.getView().state;
    const task = state.tasks[taskId]!;
    const made = await this.host.startSession({
      providerId: PANEL_ID,
      id: taskChipId(state, taskId),
      title: `Worktree for ${task.title}`.slice(0, 200),
      url: taskUrl(state, taskId),
      // Opens the task when its chip is clicked, but is never taken for a run.
      data: { taskId, worktreeFor: runId },
      projectId,
      navigation: 'preserve',
      worktree: { kind: 'new', ...(branch.trim() ? { name: branch.trim() } : {}) },
    });
    const directory = made.sessionId === null ? made.directory : made.worktree?.directory ?? made.directory;
    if (!directory) throw new Error('OpenChamber made no worktree');
    const until = Date.now() + WORKTREE_WAIT_MS;
    for (;;) {
      const listed = await this.host.listWorktrees(projectId).catch(() => null);
      if (listed?.worktrees.some((worktree) => worktree.directory === directory && worktree.status === 'ready')) break;
      if (Date.now() > until) throw new Error(`OpenChamber does not list the new worktree ${directory} yet`);
      await sleep(500);
    }
    await sleep(LOCATION_SETTLE_MS);
    return directory;
  }

  /**
   * Start an agent session for a task, optionally in a worktree, with the task
   * attached as a chip that carries the run id. With an assignee, the first
   * message is that assignee's command with the instructions as its arguments,
   * so OpenCode switches to its agent and model. Returns whether a run started.
   */
  async dispatch(taskId: string, choice: DispatchChoice): Promise<boolean> {
    if (this.view.dispatching.has(taskId)) return false;
    const state = this.client.getView().state;
    const task = state.tasks[taskId];
    if (!task) return false;
    this.set({ dispatching: new Set([...this.view.dispatching, taskId]) });
    const runId = newId();
    try {
      const assignee = choice.assignee ?? null;
      const instructions = (choice.prompt.trim() || task.title).slice(0, ATTACH_TEXT_MAX - 80);
      const project = this.view.projects.find((item) => item.id === choice.projectId);
      const command = assignee ? await this.commandFor(assignee, choice.workspace.kind === 'existing' ? choice.workspace.directory : project?.directory ?? null) : null;
      // A command must not be the first message in a folder OpenCode has not started yet.
      const workspace: WorkspaceChoice = command && choice.workspace.kind === 'new' ? { kind: 'existing', directory: await this.prepareWorktree(task.id, runId, choice.projectId, choice.workspace.branch) } : choice.workspace;
      // Cutting the end off can never put a `!` next to a backtick, so the cap stays safe.
      const text = (command ? commandText(command, instructions) : instructions).slice(0, ATTACH_TEXT_MAX);
      const result = await this.host.startSession({
        providerId: PANEL_ID,
        id: taskChipId(state, task.id),
        title: task.title.slice(0, 200),
        url: taskUrl(state, task.id),
        text,
        // The chip carries what an adoption needs to write the same run, should it win the race.
        data: { taskId: task.id, runId, ...(choice.wantsPr ? { wantsPr: true } : {}), ...(assignee ? { assignee: { ...assignee } } : {}) },
        projectId: choice.projectId,
        navigation: choice.open ? 'open' : 'preserve',
        worktree: workspace.kind === 'project' ? false : workspace.kind === 'new' ? { kind: 'new', ...(workspace.branch.trim() ? { name: workspace.branch.trim() } : {}) } : { kind: 'existing', directory: workspace.directory },
      });
      if (result.sessionId === null) {
        this.client.notify(`OpenChamber made worktree ${result.worktree.branch} but could not start the chat (${result.failure}). Start again with that existing worktree.`);
        return false;
      }
      // The session list may have shown the new chat first and adopted it as this very run.
      if (!this.client.getView().state.runs[runId]) {
        await this.client
          .dispatch([
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
                ...(choice.wantsPr ? { wantsPr: true } : {}),
                ...(assignee ? { assignee } : {}),
              },
            },
          ])
          .catch((error) => {
            if (!this.client.getView().state.runs[runId]) throw error;
          });
      }
      void this.watch(choice.projectId);
      const who = assignee?.name ?? 'an agent';
      if (result.sent === 'no-model') this.client.notify('The chat was created, but no model is set up to answer it. Open the chat to pick one.');
      else if (result.sent === 'failed') this.client.notify('The chat was created, but the first message did not send. Open the chat to send it again.');
      else this.client.notify(choice.wantsPr ? `Assigned "${task.title}" to ${who}; it will open a pull request` : `${assignee ? assignee.name : 'Agent'} started on "${task.title}"`);
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
    const bodies = [...planAdoptions(state, this.view.sessions.values()), ...planRunOutcomes(state, this.view.sessions), ...planLinkedPullRequests(state, this.view.sessions)];
    if (bodies.length === 0) return;
    this.recording = true;
    try {
      await this.client.dispatch(bodies, { origin: 'agent' });
    } finally {
      this.recording = false;
    }
    // An agent that just finished a turn has likely just opened its pull request.
    if (bodies.some((body) => body.type === 'run.outcome' && body.outcome === 'completed')) void this.refreshPullRequests();
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
