// Panel-side Linear: issue lists and projects from every connected workspace (OpenChamber's own Linear connection,
// plus workspaces added with an API key, whose keys the local service keeps), planning issues as tasks, and writing
// completion back the way Sunsama does (ask, do, or not).
//
// The store is one object, built in layers of a file each; a layer uses only the ones below it:
// - workspaces.ts: the view; OpenChamber's connection and the workspaces added with a key; GraphQL in each; what each
//   offers (teams, their states and options, the filters' catalog).
// - lists.ts: the issue lists, as Linear lists them: source, filters, display, page after page.
// - page.ts: the Linear page around its list: sections, scope, saved views and favorites, projects, where it was.
// - store.ts (this one): issues as tasks: planning them, the linked ones kept in step, edits, status moves and
//   Sunsama's prompts; and starting, refreshing, adding and removing workspaces, which touch every layer.
// Beside them, without state: types.ts (the view's shapes, what a list is) and prompts.ts (what a change to the plan
// asks or does in Linear, and what an answer does).
import { planSubtaskSourceSync, subtaskSources } from '../../../src/domain/plan/merge.ts';
import type { Command, EventBody } from '../../../src/domain/core/events.ts';
import {
  ADD_COMMENT_MUTATION,
  CREATE_ISSUE_MUTATION,
  ISSUE_DETAIL_QUERY,
  LINKED_QUERY,
  SET_STATE_MUTATION,
  UPDATE_ISSUE_MUTATION,
  githubMirrors,
  inWorkspace,
  isClosedType,
  issueSource,
  linkedIssueIdsByWorkspace,
  linkedTask,
  planLinearSync,
  planTextSave,
  priorityToLinear,
  stateOfType,
  taskFromIssue,
  type IssueInput,
  type IssueText,
  type LinearComment,
  type LinearIssue,
  type LinearIssueDetail,
  type LinearWorkspace,
} from '../../../src/domain/linear/linear.ts';
import { dropInput, type GroupTarget } from '../../../src/domain/linear/display.ts';
import { edgePosition } from '../../../src/domain/core/selectors.ts';
import { newId } from '../../../src/domain/core/ids.ts';
import type { Placement, PlannerState, Task, TaskSourceRef } from '../../../src/domain/core/types.ts';
import { messageOf } from '../../../src/domain/core/values.ts';
import type { Origin } from '../core/client.ts';
import { isFullSurface } from '../core/ui.ts';
import { emptyList, type IssueList, type IssueRef, type LinearPrompt, type LinearTeam } from './types.ts';
import { answerActions, linearActions, type LinearMove } from './prompts.ts';
import { LinearPage } from './page.ts';

export type { LinearView } from './types.ts';

const REFRESH_MS = 5 * 60_000;
const STATE_WORDS = { completed: 'Done', started: 'In Progress' } as const;

export class LinearStore extends LinearPage {
  private started = false;

  /** Begin following the connection, refreshing, and answering completed tasks. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.restoring = isFullSurface(this.surface) ? this.restoreLocation() : Promise.resolve();
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

  /** Take off a workspace added with a key: everything shown from it goes, and lists left empty are read again. */
  async removeWorkspace(id: string): Promise<void> {
    await this.client.call('DELETE', `/linear/workspaces/${encodeURIComponent(id)}`);
    await this.loadKeyWorkspaces();
    const keep = <T extends { workspaceId?: string }>(items: T[]) => items.filter((item) => item.workspaceId !== id);
    const without = <T>(byWorkspace: Record<string, T>) => Object.fromEntries(Object.entries(byWorkspace).filter(([workspaceId]) => workspaceId !== id));
    const fixList = (list: IssueList): IssueList =>
      (list.source.kind === 'view' || list.source.kind === 'project') && list.source.workspaceId === id
        ? emptyList()
        : { ...list, issues: keep(list.issues), projects: list.projects ? keep(list.projects) : null, more: without(list.more) };
    this.set({
      lists: { page: fixList(this.view.lists.page), side: fixList(this.view.lists.side) },
      views: keep(this.view.views),
      viewsMore: without(this.view.viewsMore),
      favorites: keep(this.view.favorites),
      projects: keep(this.view.projects),
      projectsMore: without(this.view.projectsMore),
      catalogs: without(this.view.catalogs),
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

  /** The issue with its Markdown description, sub-issues, links, activity and comments. */
  async issueDetail(ref: IssueRef): Promise<LinearIssueDetail> {
    const workspaceId = this.resolve(ref);
    const data = await this.graphqlIn<{ issue: LinearIssueDetail | null }>(workspaceId, ISSUE_DETAIL_QUERY, { id: ref.id });
    if (!data.issue) throw new Error('Linear no longer has this issue');
    return inWorkspace(data.issue, workspaceId);
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

  /**
   * A card dropped on a group: its team's state of that exact name, or the
   * group's priority, assignee, project or cycle, as Linear does on a board.
   */
  async moveToGroup(issue: LinearIssue, target: GroupTarget): Promise<boolean> {
    if (this.view.moving.has(issue.id)) return false;
    try {
      const workspaceId = this.resolve(issue);
      const states = target.kind === 'state' ? await this.statesOf(workspaceId, issue.team.id) : [];
      const change = dropInput(issue, target, states);
      if (!change) return false;
      if ('error' in change) throw new Error(change.error);
      this.setMoving(issue.id, true);
      if (change.input.stateId) {
        const task = linkedTask(this.client.getView().state, issue.id);
        await this.setState(workspaceId, issue.id, change.input.stateId, task && !task.completedAt ? task : null);
      } else {
        await this.updateIssue({ id: issue.id, workspaceId }, change.input);
      }
      return true;
    } catch (error) {
      this.client.notify(`Couldn't move ${issue.identifier} in Linear: ${messageOf(error)}`);
      return false;
    } finally {
      if (this.view.moving.has(issue.id)) this.setMoving(issue.id, false);
    }
  }

  /** Move the issue behind `task` to its team's first completed or started state. */
  moveIssue(task: Task, type: 'completed' | 'started'): Promise<boolean> {
    return task.source?.kind === 'linear' ? this.move({ source: task.source, to: type, task }) : Promise.resolve(false);
  }

  /** Move the issue behind a linked task to one of its team's states (the status prompt's choice). */
  setStatus(task: Task, stateId: string): Promise<boolean> {
    return task.source?.kind === 'linear' ? this.move({ source: task.source, to: { stateId }, task }) : Promise.resolve(false);
  }

  /** The issue a prompt is about: the task's own, or one merged into it (none for a prompt about several). */
  promptSource(prompt: LinearPrompt, state: PlannerState = this.client.getView().state): TaskSourceRef | null {
    if (prompt.many) return null;
    const task = state.tasks[prompt.taskId];
    const source = prompt.subtaskId ? task?.subtasks.find((subtask) => subtask.id === prompt.subtaskId)?.source : task?.source;
    return source?.kind === 'linear' ? source : null;
  }

  /** No import prompt for this task: its status was offered as it was added (a pasted issue's, in the add field). */
  dismissImportPrompt(taskId: string): void {
    if (this.view.prompt?.kind === 'import' && this.view.prompt.taskId === taskId) this.set({ prompt: null });
  }

  /** The prompt's answer: the state chosen (or, without one, Done or In Progress); Always makes completing or planning do it by itself. */
  answerPrompt(answer: 'yes' | 'no' | 'always', stateId?: string): void {
    const prompt = this.view.prompt;
    this.set({ prompt: null });
    if (!prompt || answer === 'no') return;
    const task = this.client.getView().state.tasks[prompt.taskId];
    if (!task) return;
    const { settings, moves } = answerActions(prompt, answer === 'always', stateId, task);
    if (settings) void this.client.dispatch([{ type: 'settings.updated', patch: settings }]);
    for (const move of moves) void this.move(move);
  }

  /**
   * Move an issue in Linear: to one of its team's states, or to its team's first of a type. A task whose own issue it
   * is follows at once; an issue merged into a task, its subtask follows at the next sync.
   */
  private async move({ source, to, task }: LinearMove): Promise<boolean> {
    if (this.view.moving.has(source.id)) return false;
    this.setMoving(source.id, true);
    try {
      const workspaceId = this.resolve(source);
      const teamId = source.teamId ?? (await this.issueIn(workspaceId, source.id))?.team.id;
      if (!teamId) throw new Error('the issue was not found');
      const states = await this.statesOf(workspaceId, teamId);
      const state = typeof to === 'string' ? stateOfType(states, to) : states.find((item) => item.id === to.stateId);
      if (!state) throw new Error(typeof to === 'string' ? `its team has no ${STATE_WORDS[to]} state` : 'its team has no such state');
      await this.setState(workspaceId, source.id, state.id, task);
      return true;
    } catch (error) {
      this.client.notify(`Couldn't update ${source.key} in Linear: ${messageOf(error)}`);
      return false;
    } finally {
      this.setMoving(source.id, false);
    }
  }

  /** Set an issue's state in Linear: it shows so everywhere, `task` follows, and a note says so. */
  private async setState(workspaceId: string, issueId: string, stateId: string, task: Task | null): Promise<void> {
    const data = await this.graphqlIn<{ issueUpdate: { success: boolean; issue: LinearIssue | null } }>(workspaceId, SET_STATE_MUTATION, { id: issueId, stateId });
    if (!data.issueUpdate.success || !data.issueUpdate.issue) throw new Error('Linear did not accept the change');
    const issue = inWorkspace(data.issueUpdate.issue, workspaceId);
    this.replaceIssue(issue);
    if (task) await this.client.dispatch([{ type: 'task.sourceSynced', taskId: task.id, source: issueSource(issue, task.source) }], { origin: 'linear' });
    this.client.notify(`${issue.identifier} is now ${issue.state.name} in Linear`);
  }

  /** An issue with a change on its way to Linear, or no longer. */
  private setMoving(issueId: string, on: boolean): void {
    const moving = new Set(this.view.moving);
    if (on) moving.add(issueId);
    else moving.delete(issueId);
    this.set({ moving });
  }

  /** An edit made here: show it everywhere and bring linked tasks along (not sent back). */
  private async issueChanged(issue: LinearIssueDetail): Promise<void> {
    // Lists keep the light shape (they travel as drag data); the editor keeps the full one.
    const { description: _description, comments: _comments, children: _children, attachments: _attachments, history: _history, ...listed } = issue;
    this.replaceIssue(listed);
    if (this.surface !== 'status') await this.sync({ [issue.id]: listed });
  }

  /** The user's own changes to the plan, as Sunsama's Linear automation answers them: a prompt, or a move in Linear. */
  private afterCommit(commands: readonly Command[], before: PlannerState, after: PlannerState, origin: Origin): void {
    if (origin !== 'user' || !this.available()) return;
    for (const action of linearActions(commands, before, after)) {
      if ('move' in action) void this.move(action.move);
      // Only surfaces with room for the question ask it.
      else if (this.surface !== 'status') this.set({ prompt: action.ask });
    }
  }

  /** Tasks (and issues merged into them) brought in step with their issues as Linear has them now. */
  private async sync(linked: Record<string, LinearIssue>): Promise<void> {
    const { state, today } = this.client.getView();
    const merged = new Map(Object.values(linked).map((issue) => [issue.id, { title: issue.title, status: { name: issue.state.name, type: issue.state.type, color: issue.state.color }, closed: isClosedType(issue.state.type) }]));
    const bodies = [...planLinearSync(state, new Map(Object.entries(linked)), { today, importCompletion: state.settings.linearImportCompletion }), ...planSubtaskSourceSync(state, 'linear', merged)];
    if (bodies.length) await this.client.dispatch(bodies, { origin: 'linear' });
  }

  /** Issues behind open linked tasks, read from the workspace each lives in. */
  private async fetchLinked(): Promise<{ issues: Record<string, LinearIssue>; errors: Map<string, string>; asked: string[] }> {
    const state = this.client.getView().state;
    const fallback = this.hostWorkspace?.id ?? null;
    // Linked tasks' issues, and issues merged into tasks (they stay synced, as in Sunsama), by workspace.
    const byWorkspace = new Map(linkedIssueIdsByWorkspace(state, fallback));
    for (const source of subtaskSources(state, 'linear')) {
      const workspaceId = source.workspaceId ?? fallback;
      if (workspaceId) byWorkspace.set(workspaceId, [...new Set([...(byWorkspace.get(workspaceId) ?? []), source.id])]);
    }
    const groups = [...byWorkspace].filter(([workspaceId]) => this.workspace(workspaceId));
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
}
