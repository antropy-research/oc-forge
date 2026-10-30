import { useEffect, useState } from 'preact/hooks';
import type { Task } from '../../src/domain/types.ts';
import { addDays, monthDay } from '../../src/domain/dates.ts';
import { githubMirrors, groupViews, isClosedType, isIssueView, linkedTask, type LinearIssue } from '../../src/domain/linear.ts';
import { groupIssues, sortIssues } from '../../src/domain/linearDisplay.ts';
import { LINEAR_DRAG_TYPE, usePlanner, useLinear, useView } from '../lib/context.ts';
import { useUi } from '../lib/ui.ts';
import { displayOf, type LinearSource, type LinearTeam } from '../lib/linear.ts';
import { useDayTargets } from '../lib/dayTargets.ts';
import { ConnectLinear, LinearErrors, messageOf, needsConnect, workspaceLabel, workspaceNames } from './linear/common.tsx';
import { FilterBar } from './linear/FilterBar.tsx';
import { BOARD_DRAG_TYPE } from './linear/IssueCollection.tsx';
import { PlanActions } from './PlanActions.tsx';
import { AssignButton } from './AssigneePicker.tsx';

export { ConnectLinear } from './linear/common.tsx';
export { LinearPage } from './linear/LinearPage.tsx';

const PRIORITY_MARK: Record<number, string> = { 1: '!!!', 2: '!!', 3: '!', 4: '·' };

const plannedLabel = (task: Task, today: string): string => {
  if (task.completedAt) return 'Done';
  if (task.placement.kind === 'backlog') return 'In backlog';
  if (task.placement.date === today) return 'Today';
  if (task.placement.date === addDays(today, 1)) return 'Tomorrow';
  return monthDay(task.placement.date);
};

const IssueRow = ({ issue, showAssignee }: { issue: LinearIssue; showAssignee?: boolean }) => {
  const { linear, client } = usePlanner();
  const view = useView();
  const lv = useLinear();
  const { setUi } = useUi();
  const targets = useDayTargets();
  /** Plan the issue on the first day shown: the task its assignee works on. */
  const assign = async () => {
    const { bodies, taskId } = linear.importCommands(issue, { kind: 'day', date: targets.primary });
    await client.dispatch(bodies, { undo: `Planned ${issue.identifier}` });
    return taskId;
  };
  const linked = linkedTask(view.state, issue.id, githubMirrors(issue));
  const workspace = workspaceLabel(lv, issue.workspaceId);
  return (
    <li
      class={`issue-row${lv.moving.has(issue.id) ? ' is-moving' : ''}`}
      draggable
      onDragStart={(event) => {
        event.dataTransfer?.setData(LINEAR_DRAG_TYPE, JSON.stringify(issue));
        event.dataTransfer?.setData(BOARD_DRAG_TYPE, `${issue.workspaceId ?? ''}:${issue.id}`);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove';
      }}
      aria-label={`${issue.identifier} ${issue.title}`}
    >
      <span class="issue-state" style={{ '--item-color': issue.state.color }} title={issue.state.name} aria-hidden="true" />
      <span class="issue-main">
        {/* A span, not a button, so dragging the row still starts on the title. */}
        <span
          class="issue-title is-openable"
          role="button"
          tabIndex={0}
          aria-label={`Edit ${issue.identifier}`}
          title="Open the issue"
          onClick={() => setUi({ openIssue: { id: issue.id, workspaceId: issue.workspaceId ?? null } })}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            setUi({ openIssue: { id: issue.id, workspaceId: issue.workspaceId ?? null } });
          }}
        >
          {issue.title}
        </span>
        <span class="issue-meta">
          <span class="issue-key">{issue.identifier}</span>
          {workspace && <span class="ws-badge">{workspace}</span>}
          {PRIORITY_MARK[issue.priority] && <span class={`issue-priority p${issue.priority}`} title="Priority">{PRIORITY_MARK[issue.priority]}</span>}
          {showAssignee && <span>{issue.assignee?.name ?? 'Unassigned'}</span>}
          {issue.project && <span>{issue.project.name}</span>}
          {issue.cycle && <span>Cycle {issue.cycle.number}</span>}
          {issue.dueDate && <span class={issue.dueDate < view.today ? 'due is-overdue' : 'due'}>Due {monthDay(issue.dueDate)}</span>}
        </span>
      </span>
      {linked ? (
        <button class="link issue-planned" onClick={() => setUi({ openTaskId: linked.id })} title="Open the task" aria-label={`Open the task for ${issue.identifier} (${plannedLabel(linked, view.today)})`}>
          {plannedLabel(linked, view.today)}
        </button>
      ) : (
        <PlanActions label={issue.identifier} onPlan={(placement) => void linear.plan(issue, placement)}>
          <AssignButton taskId={null} prepare={assign} label={`Assign ${issue.identifier} to an agent`}>Agent</AssignButton>
        </PlanActions>
      )}
    </li>
  );
};

/** All connected workspaces merged, or one of them. */
const WorkspaceSelect = () => {
  const { linear } = usePlanner();
  const lv = useLinear();
  if (lv.workspaces.length < 2) return null;
  return (
    <select class="workspace-select" aria-label="Linear workspace" value={lv.scope} onChange={(event) => linear.setScope(event.currentTarget.value)}>
      <option value="all">All workspaces</option>
      {lv.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
    </select>
  );
};

const sourceValue = (source: LinearSource): string => (source.kind === 'view' ? `view:${source.workspaceId}:${source.id}` : source.kind);

const sourceOf = (value: string, current: LinearSource): LinearSource => {
  const match = /^view:([^:]+):(.+)$/.exec(value);
  if (match) return { kind: 'view', workspaceId: match[1]!, id: match[2]! };
  if (value === 'created' || value === 'subscribed') return { kind: value };
  if (value === 'search' && current.kind === 'search') return current;
  return { kind: 'assigned' };
};

/**
 * Sunsama's Linear panel beside a day (Today, Calendar, planning): my issues,
 * a saved view or a search, with Linear's filters, ready to drag or plan. It
 * keeps a list of its own, so the Linear page can show something else.
 */
export const LinearIssues = (_props: { page?: boolean }) => {
  const { linear } = usePlanner();
  const lv = useLinear();
  const view = useView();
  const [term, setTerm] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  useEffect(() => linear.use('side'), [linear]);
  if (needsConnect(lv)) return <ConnectLinear />;
  const list = lv.lists.side;
  const display = displayOf(list, view.state.settings, 'side');
  const views = lv.views.filter((item) => isIssueView(item) && (lv.scope === 'all' || item.workspaceId === lv.scope));
  const names = lv.scope === 'all' ? workspaceNames(lv) : undefined;
  const groups = groupIssues(sortIssues(list.issues, display.orderBy, display.orderReverse), display.groupBy, { layout: 'list', workspaceNames: workspaceNames(lv) });
  const more = Object.keys(list.more).length > 0;
  return (
    <div class="linear-issues">
      <div class="linear-toolbar">
        <WorkspaceSelect />
        <select aria-label="Linear issues to show" value={sourceValue(list.source)} onChange={(event) => linear.setSource(sourceOf(event.currentTarget.value, list.source), 'side')}>
          <optgroup label="My issues">
            <option value="assigned">Assigned to me</option>
            <option value="created">Created by me</option>
            <option value="subscribed">Subscribed</option>
          </optgroup>
          {list.source.kind === 'search' && <option value="search">Search results</option>}
          {groupViews(views, names).map((group) => (
            <optgroup key={group.key} label={group.label}>
              {group.views.map((item) => {
                // Favorites mix workspaces; the other groups name theirs already.
                const workspace = group.key === 'favorites' && lv.scope === 'all' ? workspaceLabel(lv, item.workspaceId) : null;
                return <option key={`${item.workspaceId}:${item.id}`} value={`view:${item.workspaceId}:${item.id}`}>{workspace ? `${item.name} · ${workspace}` : item.name}</option>;
              })}
            </optgroup>
          ))}
        </select>
        <button class="icon-button" aria-label="Refresh Linear" title={lv.syncedAt ? `Synced ${new Date(lv.syncedAt).toLocaleTimeString()}` : 'Refresh'} onClick={() => void linear.refresh()}>↻</button>
      </div>
      <input
        class="linear-search"
        value={term}
        placeholder="Search Linear issues"
        aria-label="Search Linear issues"
        onInput={(event) => setTerm(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          const query = term.trim();
          linear.setSource(query ? { kind: 'search', term: query } : { kind: 'assigned' }, 'side');
        }}
      />
      <FilterBar listId="side" open={filterOpen} onOpenChange={setFilterOpen} compact />
      <LinearErrors error={list.error ?? lv.error} workspaceIds={linear.workspacesOf(list)} />
      {list.loading && list.issues.length === 0 && <p class="hint">Loading issues…</p>}
      {!list.loading && list.issues.length === 0 && !list.error && <p class="hint">{list.filters.length ? 'No issues match these filters.' : 'No open issues here.'}</p>}
      {groups.map((group) => (
        <section key={group.key} class="issue-group" aria-label={group.label}>
          {display.groupBy !== 'none' && <h3>{group.label} <span class="count">{group.issues.length}{more ? '+' : ''}</span></h3>}
          <ul class="issue-list">{group.issues.map((issue) => <IssueRow key={issue.id} issue={issue} showAssignee={list.source.kind !== 'assigned'} />)}</ul>
        </section>
      ))}
      {more && (
        <div class="lin-more">
          <span class="muted">{list.issues.length} loaded</span>
          <button type="button" class="lin-button" disabled={list.loadingMore} onClick={() => void linear.loadMore('side')}>{list.loadingMore ? 'Loading…' : 'Load more'}</button>
        </div>
      )}
    </div>
  );
};

/** The question Sunsama asks after completing or planning a linked task. */
export const LinearPromptBar = () => {
  const { linear } = usePlanner();
  const lv = useLinear();
  const prompt = lv.prompt;
  useEffect(() => {
    if (!prompt) return;
    // An unanswered question goes away on its own; the task detail can still move the issue.
    const timer = setTimeout(() => linear.answerPrompt('no'), 20_000);
    return () => clearTimeout(timer);
  }, [prompt, linear]);
  if (!prompt) return null;
  const target = prompt.kind === 'complete' ? 'Done' : 'In Progress';
  return (
    <div class="linear-prompt" role="alertdialog" aria-label={`Update ${prompt.key} in Linear`}>
      <span>Move <strong>{prompt.key}</strong> to {target} in Linear?</span>
      <button class="primary" onClick={() => linear.answerPrompt('yes')}>Move</button>
      <button onClick={() => linear.answerPrompt('always')}>Always</button>
      <button class="link" onClick={() => linear.answerPrompt('no')}>Not now</button>
    </div>
  );
};

const CreateIssue = ({ task }: { task: Task }) => {
  const { linear, client } = usePlanner();
  const lv = useLinear();
  const [teams, setTeams] = useState<LinearTeam[] | null>(null);
  const [teamId, setTeamId] = useState('');
  const [busy, setBusy] = useState(false);
  const workspaceCount = lv.workspaces.length;
  useEffect(() => {
    let live = true;
    linear
      .teams()
      .then((list) => {
        if (!live) return;
        setTeams(list);
        setTeamId((current) => (list.some((team) => team.id === current) ? current : list[0]?.id ?? ''));
      })
      .catch(() => live && setTeams([]));
    return () => {
      live = false;
    };
  }, [linear, workspaceCount]);
  if (!teams) return <p class="hint">Loading teams…</p>;
  if (teams.length === 0) return <p class="hint">No Linear teams available.</p>;
  const team = teams.find((item) => item.id === teamId);
  return (
    <div class="row">
      <select aria-label="Linear team" value={teamId} onChange={(event) => setTeamId(event.currentTarget.value)}>
        {teams.map((item) => {
          const workspace = workspaceLabel(lv, item.workspaceId);
          return <option key={item.id} value={item.id}>{workspace ? `${workspace} · ` : ''}{item.key} · {item.name}</option>;
        })}
      </select>
      {linear.teamsCut.size > 0 && <span class="hint" role="note">Linear has more teams than listed here</span>}
      <button
        class="link"
        disabled={busy || !team}
        onClick={() => {
          if (!team) return;
          setBusy(true);
          linear
            .createIssue(task, team)
            .catch((error) => client.notify(`Could not create the issue: ${messageOf(error)}`))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Creating…' : 'Create Linear issue'}
      </button>
    </div>
  );
};

/** The task detail's Linear section: the linked issue, or a way to create one. */
export const LinearTaskSection = ({ task }: { task: Task }) => {
  const { client, host, linear } = usePlanner();
  const lv = useLinear();
  const { setUi } = useUi();
  const source = task.source;
  if (source?.kind === 'linear') {
    const live = lv.linked[source.id];
    const status = live ? { name: live.state.name, type: live.state.type, color: live.state.color } : source.status;
    const closed = isClosedType(status?.type);
    const reachable = Boolean(linear.workspace(linear.workspaceOf(source)));
    const workspace = workspaceLabel(lv, linear.workspaceOf(source));
    return (
      <section class="detail-section" aria-label="Linear">
        <h3>
          Linear
          <span class="source-chip" style={{ '--item-color': status?.color ?? '#5e6ad2' }}><span class="dot" aria-hidden="true" />{source.key}</span>
          {status && <span class="count">{status.name}</span>}
          {workspace && <span class="ws-badge">{workspace}</span>}
        </h3>
        <div class="row">
          {reachable && <button class="link" onClick={() => setUi({ openIssue: { id: source.id, workspaceId: linear.workspaceOf(source) } })}>Edit issue</button>}
          <button class="link" onClick={() => void host.openUrl(source.url)}>Open in Linear</button>
          {!closed && reachable && <button class="link" onClick={() => void linear.moveIssue(task, 'completed')}>Mark done in Linear</button>}
          {['backlog', 'unstarted', 'triage'].includes(status?.type ?? '') && reachable && <button class="link" onClick={() => void linear.moveIssue(task, 'started')}>Start in Linear</button>}
          <button class="link danger" onClick={() => void client.dispatch([{ type: 'task.updated', taskId: task.id, patch: { source: null } }], { undo: 'Link removed' })}>Unlink</button>
        </div>
        {!reachable && lv.connected !== null && <p class="hint">{source.workspaceId ? "This issue's workspace is not connected; add it in Settings → Linear to update it from here." : 'Connect Linear to update this issue from here.'}</p>}
        {source.branch && <p class="hint">Branch <code>{source.branch}</code>: an agent's worktree uses it, so its pull request links back to {source.key}.</p>}
      </section>
    );
  }
  if (source) return null;
  return (
    <section class="detail-section" aria-label="Linear">
      <h3>Linear</h3>
      {needsConnect(lv) ? <button class="link" onClick={() => void linear.connect()}>Connect Linear to create an issue from this task</button> : <CreateIssue task={task} />}
    </section>
  );
};
