// Agent runs on tasks: what a run's status is, which need the user, and which
// facts about sessions are worth writing down.
import type { PlannerState, RunPullRequest, TaskRun, TaskSourceRef } from './types.ts';
import { isRunAssignee } from './assignees.ts';

/** How the first message names a task's source. */
const SOURCE_LABELS: Record<TaskSourceRef['kind'], string> = { linear: 'Linear issue', github: 'GitHub', gtask: 'Google task', email: 'Email in Gmail' };
import type { EventBody, SeenPullRequest } from './events.ts';

export type SessionActivity = 'unknown' | 'idle' | 'running' | 'retrying' | 'waiting-permission' | 'waiting-question';

/** What OpenChamber currently says about a session. */
export interface LiveSession {
  id: string;
  title: string;
  projectId: string;
  directory: string;
  activity: SessionActivity;
  /** The last observed turn; never a task status. */
  outcome: 'completed' | 'failed' | null;
  updatedAt: number;
  archivedAt: number | null;
  worktree: { directory: string; branch: string } | null;
  items: { id: string; data?: unknown }[];
  /** Issues and code changes linked to the chat, by anyone (the agent too); hosts before 2.5.2 send none. */
  links?: { title: string; url: string; kind: 'issue' | 'change' }[];
}

export type RunStatus = 'running' | 'question' | 'permission' | 'review' | 'failed' | 'changes' | 'accepted' | 'idle' | 'archived';

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  running: 'Agent working',
  question: 'Agent has a question',
  permission: 'Agent needs permission',
  review: 'Ready for review',
  failed: 'Agent run failed',
  changes: 'Changes requested',
  accepted: 'Result accepted',
  idle: 'Agent idle',
  archived: 'Chat archived',
};

export const runsFor = (state: PlannerState, taskId: string): TaskRun[] =>
  Object.values(state.runs).filter((run) => run.taskId === taskId).sort((a, b) => a.startedAt.localeCompare(b.startedAt));

/**
 * A run's status: what the agent is doing now if it is doing anything, else
 * what is left for the user. A finished turn is "ready for review", never done.
 */
export const runStatus = (run: TaskRun, live?: LiveSession): RunStatus => {
  const activity = live?.activity;
  if (activity === 'waiting-question') return 'question';
  if (activity === 'waiting-permission') return 'permission';
  if (activity === 'running' || activity === 'retrying') return 'running';
  if (run.review?.verdict === 'accepted') return 'accepted';
  if (live?.archivedAt) return 'archived';
  const outcome = live?.outcome ?? run.outcome;
  if (outcome === 'failed') return 'failed';
  if (outcome === 'completed') return run.review?.verdict === 'changes' ? 'changes' : 'review';
  return 'idle';
};

/** Statuses that wait on the user. */
export const needsYou = (status: RunStatus): boolean => status === 'question' || status === 'permission' || status === 'review' || status === 'failed';

/** Statuses where an agent is still at work; starting another would duplicate it. */
export const isActive = (status: RunStatus): boolean => status === 'running' || status === 'question' || status === 'permission';

/** The status to show for a task: the run that most needs attention, else the latest. */
export const taskRunStatus = (state: PlannerState, taskId: string, sessions: ReadonlyMap<string, LiveSession>): RunStatus | null => {
  const runs = runsFor(state, taskId);
  if (runs.length === 0) return null;
  const statuses = runs.map((run) => runStatus(run, sessions.get(run.sessionId)));
  const order: RunStatus[] = ['question', 'permission', 'failed', 'review', 'running', 'changes', 'idle', 'accepted', 'archived'];
  return order.find((status) => statuses.includes(status)) ?? statuses[statuses.length - 1]!;
};

/**
 * Outcomes worth recording: a settled turn the log does not have yet, or a new
 * finished turn after the user asked for changes.
 */
export const planRunOutcomes = (state: PlannerState, sessions: ReadonlyMap<string, LiveSession>): EventBody[] => {
  const bodies: EventBody[] = [];
  for (const run of Object.values(state.runs)) {
    const live = sessions.get(run.sessionId);
    if (!live?.outcome || live.activity !== 'idle') continue;
    const newAfterChanges = run.review?.verdict === 'changes' && live.outcome === 'completed' && live.updatedAt > Date.parse(run.review.at);
    if (live.outcome !== run.outcome || newAfterChanges) bodies.push({ type: 'run.outcome', runId: run.id, outcome: live.outcome });
  }
  return bodies;
};

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Sessions that carry one of our tasks as an attached item but are not a known
 * run (the run could not be saved after the session started, or it started on
 * another replica). Adopting them keeps "one task, many runs" complete.
 */
export const planAdoptions = (state: PlannerState, sessions: Iterable<LiveSession>): EventBody[] => {
  const known = new Set(Object.values(state.runs).map((run) => run.sessionId));
  const bodies: EventBody[] = [];
  for (const session of sessions) {
    if (known.has(session.id)) continue;
    for (const item of session.items) {
      const data = (item.data ?? {}) as { taskId?: unknown; runId?: unknown; wantsPr?: unknown; assignee?: unknown; worktreeFor?: unknown };
      // The empty chat that made an assignee's worktree is not a run.
      if (data.worktreeFor !== undefined) continue;
      const taskId = typeof data.taskId === 'string' ? data.taskId : item.id;
      const task = state.tasks[taskId];
      if (!task || task.deletedAt) continue;
      const runId = typeof data.runId === 'string' && RUN_ID.test(data.runId) ? data.runId : `adopt-${session.id}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
      if (state.runs[runId]) continue;
      bodies.push({
        type: 'run.started',
        run: {
          id: runId,
          taskId,
          sessionId: session.id,
          projectId: session.projectId,
          directory: session.directory,
          worktree: session.worktree ? { directory: session.worktree.directory, branch: session.worktree.branch } : null,
          title: task.title,
          // An assignment's session can be adopted before its start is written down; it stays an assignment.
          ...(data.wantsPr === true ? { wantsPr: true } : {}),
          ...(isRunAssignee(data.assignee) ? { assignee: data.assignee } : {}),
        },
      });
      known.add(session.id);
      break;
    }
  }
  return bodies;
};

/** The first message for a task's agent: its title, notes, checklist and source. */
export const taskPrompt = (state: PlannerState, taskId: string): string => {
  const task = state.tasks[taskId];
  if (!task) return '';
  const parts = [task.title];
  if (task.notes.trim()) parts.push(task.notes.trim());
  const open = task.subtasks.filter((subtask) => !subtask.done);
  if (open.length) parts.push(`Checklist:\n${open.map((subtask) => `- [ ] ${subtask.title}`).join('\n')}`);
  if (task.source) parts.push(`${SOURCE_LABELS[task.source.kind]}${task.source.kind === 'gtask' || task.source.kind === 'email' ? '' : ` ${task.source.key}`}: ${task.source.url}`);
  return parts.join('\n\n');
};

/**
 * The chip id OpenChamber shows before the title (and names the chat with):
 * the Linear key for a linked task, else a short Planner tag. The task itself
 * travels in the chip's data.
 */
export const taskChipId = (state: PlannerState, taskId: string): string => state.tasks[taskId]?.source?.key ?? `PLN-${taskId.slice(-4)}`;

/**
 * The attach url OpenChamber requires (http or https): the source issue when
 * there is one, else a reserved `.invalid` address that can never resolve.
 */
export const taskUrl = (state: PlannerState, taskId: string): string => state.tasks[taskId]?.source?.url ?? `https://planner.invalid/tasks/${encodeURIComponent(taskId)}`;

/**
 * The first message when a task is assigned to an agent, as in GitHub or
 * Linear: the task, then what to hand back, which is a pull request from
 * `branch` that links the issue, named in the reply.
 */
export const assignPrompt = (state: PlannerState, taskId: string, branch: string): string => {
  const task = state.tasks[taskId];
  if (!task) return '';
  const source = task.source;
  const link =
    source?.kind === 'linear'
      ? ` Mention ${source.key} in the description, so Linear links the pull request to the issue.`
      : source?.kind === 'github' && /\/issues\/\d+$/.test(source.url)
        ? ` Put "Closes ${source.key}" in the description.`
        : '';
  return [
    taskPrompt(state, taskId),
    [
      `You are working on this in your own git worktree, on branch \`${branch}\`.`,
      '1. Make the change this task asks for, with tests where the project has them.',
      '2. Commit it with a clear message.',
      `3. Push \`${branch}\` and open a pull request with \`gh pr create\`: a title from the task, and a description of what changed and how you checked it.${link}`,
      "4. If you can, link the pull request to this chat (OpenChamber's session.link, kind change).",
      "5. Reply with the pull request's URL, or say why you could not open one.",
    ].join('\n'),
  ].join('\n\n');
};

/**
 * What the service needs to look a run's pull request up with gh: by its URL
 * once one is known, else by the run's branch in the first directory that exists.
 */
export interface PullRequestLookup {
  runId: string;
  branch: string | null;
  directories: string[];
  url?: string;
}

const LOOKUP_DAYS = 30;

/**
 * Runs whose pull request may still change: they started in the last 30 days,
 * have a worktree branch or a known pull request, and no pull request was seen
 * yet or it is open.
 */
export const pullRequestLookups = (state: PlannerState, now: number = Date.now()): PullRequestLookup[] =>
  Object.values(state.runs).flatMap((run) => {
    const branch = run.worktree?.branch ?? null;
    const url = run.pullRequest?.url;
    if ((!branch && !url) || now - Date.parse(run.startedAt) > LOOKUP_DAYS * 86_400_000) return [];
    if (run.pullRequest && run.pullRequest.state !== 'open') return [];
    const task = state.tasks[run.taskId];
    if (!task || task.deletedAt) return [];
    // The worktree may be gone once its branch merged; the project checkout knows the same repository.
    const directories = [...(run.worktree ? [run.worktree.directory] : []), ...(run.directory && run.directory !== run.worktree?.directory ? [run.directory] : [])];
    return [{ runId: run.id, branch, directories, ...(url ? { url } : {}) }];
  });

const GITHUB_PULL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})\/pull\/(\d{1,9})(?:[/?#].*)?$/;

/**
 * Pull requests linked to a run's chat (OpenChamber 2.5.2 keeps them on the
 * session, whoever linked them: the agent with session.link, or the user) for
 * runs the log has no pull request for yet. Its state is open until gh says
 * otherwise; from then on gh follows it by its URL.
 */
export const planLinkedPullRequests = (state: PlannerState, sessions: ReadonlyMap<string, LiveSession>): EventBody[] =>
  Object.values(state.runs).flatMap((run) => {
    if (run.pullRequest) return [];
    const links = (sessions.get(run.sessionId)?.links ?? []).filter((link) => link.kind === 'change');
    const found = links.map((link) => ({ link, match: GITHUB_PULL.exec(link.url) })).filter((entry) => entry.match).at(-1);
    if (!found) return [];
    const repo = found.match![1]!;
    const number = Number(found.match![2]);
    const title = found.link.title.trim().slice(0, 500) || `Pull request #${number}`;
    return [{ type: 'run.pullRequest' as const, runId: run.id, taskId: run.taskId, pullRequest: { number, url: `https://github.com/${repo}/pull/${number}`, state: 'open' as const, draft: false, title, repo } }];
  });

/** Events for the pull requests that appeared or changed since the log last saw them. */
export const planPullRequests = (state: PlannerState, found: ReadonlyMap<string, SeenPullRequest>): EventBody[] =>
  [...found].flatMap(([runId, pr]) => {
    const run = state.runs[runId];
    if (!run) return [];
    const seen = run.pullRequest;
    const same = seen && seen.number === pr.number && seen.url === pr.url && seen.state === pr.state && seen.draft === pr.draft && seen.title === pr.title && seen.repo === pr.repo;
    return same ? [] : [{ type: 'run.pullRequest' as const, runId, taskId: run.taskId, pullRequest: pr }];
  });

/** The pull request of a task's latest run that has one. */
export const taskPullRequest = (state: PlannerState, taskId: string): RunPullRequest | null =>
  runsFor(state, taskId).flatMap((run) => (run.pullRequest ? [run.pullRequest] : [])).at(-1) ?? null;
