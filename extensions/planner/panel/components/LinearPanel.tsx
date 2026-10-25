import { useEffect, useRef, useState } from 'preact/hooks';
import { LINEAR_GROUPS, LINEAR_ORDERS, type LinearGroupBy, type LinearOrderBy, type Task } from '../../src/domain/types.ts';
import { addDays, monthDay } from '../../src/domain/dates.ts';
import {
  FILTER_FIELD_LABELS,
  HEALTH_LABELS,
  LINEAR_FILTER_FIELDS,
  describeRule,
  filterIssues,
  filterOptions,
  githubMirrors,
  groupIssues,
  groupProjects,
  groupViews,
  isClosedType,
  linkedTask,
  plannedLinearTasks,
  sortIssues,
  type FilterContext,
  type FilterOption,
  type LinearFilterField,
  type LinearFilterRule,
  type LinearIssue,
  type LinearProject,
  type LinearProjectDetail,
} from '../../src/domain/linear.ts';
import { LINEAR_DRAG_TYPE, usePlanner, useLinear, useView } from '../lib/context.ts';
import { useUi } from '../lib/ui.ts';
import { issueDisplay, type LinearMode, type LinearTeam, type LinearView, type OpenProject } from '../lib/linear.ts';

const PRIORITY_MARK: Record<number, string> = { 1: '!!!', 2: '!!', 3: '!', 4: '·' };
const GROUP_LABELS: Record<LinearGroupBy, string> = { status: 'Status', priority: 'Priority', project: 'Project', team: 'Team', assignee: 'Assignee', workspace: 'Workspace', none: 'Nothing' };
const ORDER_LABELS: Record<LinearOrderBy, string> = { priority: 'Priority', updated: 'Last updated', due: 'Due date', identifier: 'Issue number' };
const MODES: { id: LinearMode; label: string }[] = [
  { id: 'issues', label: 'Issues' },
  { id: 'projects', label: 'Projects' },
  { id: 'planned', label: 'Planned' },
];
/** Drag payload for moving a card between board columns: the issue id. */
const BOARD_DRAG_TYPE = 'application/x-planner-linear-board';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const plannedLabel = (task: Task, today: string): string => {
  if (task.completedAt) return 'Done';
  if (task.placement.kind === 'backlog') return 'In backlog';
  if (task.placement.date === today) return 'Today';
  if (task.placement.date === addDays(today, 1)) return 'Tomorrow';
  return monthDay(task.placement.date);
};

/** Nothing to read: OpenChamber is not connected and no workspace was added with a key. */
const needsConnect = (lv: LinearView): boolean => lv.connected === false && lv.workspaces.length === 0;

/** A workspace's name, shown only while more than one is connected. */
const workspaceLabel = (lv: LinearView, id: string | null | undefined): string | null =>
  lv.workspaces.length > 1 ? lv.workspaces.find((workspace) => workspace.id === id)?.name ?? null : null;

const excerpt = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

export const ConnectLinear = () => {
  const { linear, client } = usePlanner();
  return (
    <div class="connect-linear">
      <p>Connect Linear to plan your issues here. Planner uses OpenChamber's own Linear connection; more workspaces can be added with an API key in Settings.</p>
      <button class="primary" onClick={() => void linear.connect().catch((error) => client.notify(`Could not start the Linear connection: ${messageOf(error)}`))}>Connect Linear</button>
    </div>
  );
};

const Progress = ({ value }: { value: number }) => {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <span class="progress" title={`${percent}% complete`}>
      <span class="progress-bar" aria-hidden="true"><span style={{ width: `${percent}%` }} /></span>
      <span class="progress-label">{percent}%</span>
    </span>
  );
};

const IssueRow = ({ issue, showAssignee }: { issue: LinearIssue; showAssignee?: boolean }) => {
  const { linear } = usePlanner();
  const view = useView();
  const lv = useLinear();
  const { setUi } = useUi();
  const linked = linkedTask(view.state, issue.id, githubMirrors(issue));
  const workspace = workspaceLabel(lv, issue.workspaceId);
  return (
    <li
      class={`issue-row${lv.moving.has(issue.id) ? ' is-moving' : ''}`}
      draggable
      onDragStart={(event) => {
        event.dataTransfer?.setData(LINEAR_DRAG_TYPE, JSON.stringify(issue));
        event.dataTransfer?.setData(BOARD_DRAG_TYPE, issue.id);
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
        <span class="issue-actions">
          <button onClick={() => void linear.plan(issue, { kind: 'day', date: view.today })} aria-label={`Plan ${issue.identifier} today`}>Today</button>
          <button onClick={() => void linear.plan(issue, { kind: 'day', date: addDays(view.today, 1) })} aria-label={`Plan ${issue.identifier} tomorrow`}>Tmrw</button>
          <button onClick={() => void linear.plan(issue, { kind: 'backlog', bucket: 'next-weeks' })} aria-label={`Put ${issue.identifier} in the backlog`}>Later</button>
        </span>
      )}
    </li>
  );
};

const workspaceNames = (lv: LinearView): Map<string, string> => new Map(lv.workspaces.map((workspace) => [workspace.id, workspace.name]));

/** Issues as a list, grouped and ordered the way the Linear page (or the open view) is set up. */
const IssueGroups = ({ issues, showAssignee }: { issues: LinearIssue[]; showAssignee?: boolean }) => {
  const view = useView();
  const lv = useLinear();
  const { linearGroupBy, linearOrderBy } = issueDisplay(lv, view.state.settings);
  const groups = groupIssues(sortIssues(issues, linearOrderBy), linearGroupBy, { workspaceNames: workspaceNames(lv) });
  return (
    <>
      {groups.map((group) => (
        <section key={group.key} class="issue-group" aria-label={group.label}>
          {linearGroupBy !== 'none' && <h3>{group.label} <span class="count">{group.issues.length}</span></h3>}
          <ul class="issue-list">{group.issues.map((issue) => <IssueRow key={issue.id} issue={issue} showAssignee={showAssignee} />)}</ul>
        </section>
      ))}
    </>
  );
};

/**
 * Issues as a board. Grouped by status, the columns follow the workflow and a
 * card dropped on one moves to its team's first state there, as in Linear.
 */
const IssueBoard = ({ issues, showAssignee }: { issues: LinearIssue[]; showAssignee?: boolean }) => {
  const { linear } = usePlanner();
  const view = useView();
  const lv = useLinear();
  const [over, setOver] = useState<string | null>(null);
  const { linearGroupBy, linearOrderBy } = issueDisplay(lv, view.state.settings);
  const byStatus = linearGroupBy === 'status' || linearGroupBy === 'none';
  const groups = groupIssues(sortIssues(issues, linearOrderBy), byStatus ? 'status' : linearGroupBy, { board: true, workspaceNames: workspaceNames(lv) });
  return (
    <div class="issue-board">
      {groups.map((group) => {
        const droppable = byStatus && Boolean(group.stateType);
        return (
          <section
            key={group.key}
            class={`board-column${over === group.key ? ' is-over' : ''}`}
            aria-label={group.label}
            onDragOver={(event) => {
              if (!droppable || !event.dataTransfer?.types.includes(BOARD_DRAG_TYPE)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setOver(group.key);
            }}
            onDragLeave={(event) => {
              if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) setOver(null);
            }}
            onDrop={(event) => {
              if (!droppable) return;
              event.preventDefault();
              setOver(null);
              const issue = issues.find((item) => item.id === event.dataTransfer?.getData(BOARD_DRAG_TYPE));
              if (issue) void linear.moveIssueToType(issue, group.stateType!);
            }}
          >
            <h3>{group.label} <span class="count">{group.issues.length}</span></h3>
            <ul class="issue-list">{group.issues.map((issue) => <IssueRow key={issue.id} issue={issue} showAssignee={showAssignee} />)}</ul>
            {droppable && group.issues.length === 0 && <p class="hint board-drop">{group.stateType === 'completed' ? 'Drop an issue here to complete it in Linear' : 'Drop an issue here'}</p>}
          </section>
        );
      })}
    </div>
  );
};

/** List or board, as the page (or the open view) is set up; side panels always list. */
const IssueLayout = ({ issues, page, showAssignee }: { issues: LinearIssue[]; page?: boolean; showAssignee?: boolean }) => {
  const view = useView();
  const lv = useLinear();
  return page && issueDisplay(lv, view.state.settings).linearLayout === 'board' ? <IssueBoard issues={issues} showAssignee={showAssignee} /> : <IssueGroups issues={issues} showAssignee={showAssignee} />;
};

const DisplayControls = () => {
  const { linear } = usePlanner();
  const view = useView();
  const lv = useLinear();
  const settings = issueDisplay(lv, view.state.settings);
  const groups = LINEAR_GROUPS.filter((group) => group !== 'workspace' || lv.workspaces.length > 1 || settings.linearGroupBy === 'workspace');
  return (
    <div class="linear-display" role="group" aria-label="Display" title={lv.source.kind === 'view' ? "This view's display, as saved in Linear; changes last until you leave the view" : undefined}>
      <div class="segmented" role="radiogroup" aria-label="Layout">
        <button role="radio" aria-checked={settings.linearLayout === 'list'} onClick={() => void linear.setDisplay({ linearLayout: 'list' })}>List</button>
        <button role="radio" aria-checked={settings.linearLayout === 'board'} onClick={() => void linear.setDisplay({ linearLayout: 'board' })}>Board</button>
      </div>
      <label class="inline">
        Group by
        <select aria-label="Group issues by" value={settings.linearGroupBy} onChange={(event) => void linear.setDisplay({ linearGroupBy: event.currentTarget.value as LinearGroupBy })}>
          {groups.map((group) => <option key={group} value={group}>{GROUP_LABELS[group]}</option>)}
        </select>
      </label>
      <label class="inline">
        Order by
        <select aria-label="Order issues by" value={settings.linearOrderBy} onChange={(event) => void linear.setDisplay({ linearOrderBy: event.currentTarget.value as LinearOrderBy })}>
          {LINEAR_ORDERS.map((order) => <option key={order} value={order}>{ORDER_LABELS[order]}</option>)}
        </select>
      </label>
    </div>
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

/** What failed: per workspace while several are connected, else the one error. */
const LinearErrors = () => {
  const lv = useLinear();
  if (lv.workspaces.length < 2) return lv.error ? <p class="feed-errors" role="alert">{lv.error}</p> : null;
  const failed = lv.workspaces.filter((workspace) => workspace.error && (lv.scope === 'all' || lv.scope === workspace.id));
  return failed.length ? <p class="feed-errors" role="alert">{failed.map((workspace) => `${workspace.name}: ${workspace.error}`).join(' · ')}</p> : null;
};

/** Pick a field, then its values; a field that has a rule already opens that rule. */
const FilterMenu = ({
  issues,
  filters,
  context,
  start,
  onChange,
  onClose,
}: {
  issues: readonly LinearIssue[];
  filters: LinearFilterRule[];
  context: FilterContext;
  start: LinearFilterField | null;
  onChange: (next: LinearFilterRule[]) => void;
  onClose: () => void;
}) => {
  const lv = useLinear();
  const ref = useRef<HTMLDivElement>(null);
  const [field, setField] = useState<LinearFilterField | null>(start);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape, true);
    };
  }, [onClose]);
  if (!field) {
    const fields = LINEAR_FILTER_FIELDS.filter((item) => item !== 'workspace' || lv.workspaces.length > 1);
    return (
      <div class="menu filter-menu" ref={ref} role="menu" aria-label="Filter by">
        {fields.map((item) => (
          <button key={item} role="menuitem" onClick={() => setField(item)}>
            {FILTER_FIELD_LABELS[item]}
            {filters.some((rule) => rule.field === item) && <span class="count"> · in use</span>}
          </button>
        ))}
      </div>
    );
  }
  const index = filters.findIndex((rule) => rule.field === field);
  const rule = index >= 0 ? filters[index]! : { field, negate: false, values: [] };
  const options = filterOptions(issues, field, context);
  // A chosen value no shown issue has any more still shows, so it can be unticked.
  const extra: FilterOption[] = rule.values.filter((item) => !options.some((option) => option.value === item.value)).map((item) => ({ ...item, count: 0 }));
  // A rule with no value left goes away; an existing one keeps its place; a new one goes last.
  const save = (next: LinearFilterRule) => {
    if (!next.values.length) onChange(filters.filter((item) => item.field !== field));
    else if (index >= 0) onChange(filters.map((item, at) => (at === index ? next : item)));
    else onChange([...filters, next]);
  };
  const toggle = (option: { value: string; label: string }, on: boolean) =>
    save({ ...rule, values: on ? [...rule.values, { value: option.value, label: option.label }] : rule.values.filter((item) => item.value !== option.value) });
  return (
    <div class="menu filter-menu" ref={ref} role="dialog" aria-label={`Filter by ${FILTER_FIELD_LABELS[field]}`}>
      <div class="filter-menu-head">
        {!start && <button class="link" onClick={() => setField(null)} aria-label="Back to the fields">←</button>}
        <strong>{FILTER_FIELD_LABELS[field]}</strong>
        <div class="segmented" role="radiogroup" aria-label="Match">
          <button role="radio" aria-checked={!rule.negate} onClick={() => rule.values.length && save({ ...rule, negate: false })}>is</button>
          <button role="radio" aria-checked={rule.negate} onClick={() => rule.values.length && save({ ...rule, negate: true })}>is not</button>
        </div>
      </div>
      {options.length + extra.length === 0 && <p class="hint">No issue here has one.</p>}
      <ul class="filter-options">
        {[...options, ...extra].map((option) => (
          <li key={option.value || '(none)'}>
            <label class="inline">
              <input type="checkbox" checked={rule.values.some((item) => item.value === option.value)} onChange={(event) => toggle(option, event.currentTarget.checked)} />
              {option.color && <span class="dot" style={{ '--item-color': option.color }} aria-hidden="true" />}
              <span class="filter-option-label">{option.label}</span>
              <span class="count">{option.count}</span>
            </label>
          </li>
        ))}
      </ul>
      <div class="row">
        <div class="nav-spacer" />
        <button class="link" onClick={onClose}>Done</button>
      </div>
    </div>
  );
};

/**
 * Linear's temporary filters: chips that read like "Status is Todo", to edit
 * or remove, and "+ Filter" to add one. Values come from the issues given.
 */
const FilterBar = ({ issues, filters, onChange }: { issues: readonly LinearIssue[]; filters: LinearFilterRule[]; onChange: (next: LinearFilterRule[]) => void }) => {
  const view = useView();
  const lv = useLinear();
  const [open, setOpen] = useState<{ field: LinearFilterField | null } | null>(null);
  const context: FilterContext = { today: view.today, workspaceNames: workspaceNames(lv) };
  const close = () => setOpen(null);
  return (
    <div class="linear-filters" role="group" aria-label="Filters">
      {filters.map((rule) => {
        const text = describeRule(rule);
        return (
          <span key={rule.field} class="filter-chip">
            <button class="filter-chip-label" onClick={() => setOpen({ field: rule.field })} aria-label={`Edit filter: ${text}`} title={text}>{text}</button>
            <button class="filter-chip-remove" onClick={() => onChange(filters.filter((item) => item.field !== rule.field))} aria-label={`Remove filter: ${text}`}>×</button>
          </span>
        );
      })}
      <span class="menu-anchor">
        <button class="link" aria-haspopup="menu" aria-expanded={open !== null} onClick={() => setOpen(open ? null : { field: null })}>+ Filter</button>
        {open && <FilterMenu key={open.field ?? 'fields'} issues={issues} filters={filters} context={context} start={open.field} onChange={onChange} onClose={close} />}
      </span>
      {filters.length > 0 && <button class="link" onClick={() => onChange([])}>Clear filters</button>}
    </div>
  );
};

/** "12 of 40 issues" while filters hide some. */
const FilterCount = ({ shown, total, filtered }: { shown: number; total: number; filtered: boolean }) =>
  filtered && total > 0 ? <p class="hint filter-count" aria-live="polite">{shown} of {total} issue{total === 1 ? '' : 's'}</p> : null;

/** Sunsama's Linear panel: My issues, a saved view or a search, grouped, ready to drag or plan. */
export const LinearIssues = ({ page = false }: { page?: boolean }) => {
  const { linear } = usePlanner();
  const lv = useLinear();
  const view = useView();
  const [term, setTerm] = useState('');
  if (needsConnect(lv)) return <ConnectLinear />;
  const sourceValue = lv.source.kind === 'view' ? `view:${lv.source.workspaceId}:${lv.source.id}` : lv.source.kind;
  const views = lv.views.filter((item) => lv.scope === 'all' || item.workspaceId === lv.scope);
  const names = lv.scope === 'all' ? workspaceNames(lv) : undefined;
  const open = lv.issues.filter((issue) => !isClosedType(issue.state.type));
  const visible = filterIssues(open, lv.filters, { today: view.today, workspaceNames: workspaceNames(lv) });
  return (
    <div class="linear-issues">
      <div class="linear-toolbar">
        {!page && <WorkspaceSelect />}
        <select
          aria-label="Linear issues to show"
          value={sourceValue}
          onChange={(event) => {
            const value = event.currentTarget.value;
            const match = /^view:([^:]+):(.+)$/.exec(value);
            linear.setSource(match ? { kind: 'view', workspaceId: match[1]!, id: match[2]! } : { kind: 'assigned' });
          }}
        >
          <option value="assigned">My issues</option>
          {lv.source.kind === 'search' && <option value="search">Search results</option>}
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
          linear.setSource(query ? { kind: 'search', term: query } : { kind: 'assigned' });
        }}
      />
      {page && <DisplayControls />}
      <FilterBar issues={open} filters={lv.filters} onChange={(next) => linear.setFilters(next)} />
      <LinearErrors />
      {lv.loading && lv.issues.length === 0 && <p class="hint">Loading issues…</p>}
      <FilterCount shown={visible.length} total={open.length} filtered={lv.filters.length > 0} />
      {!lv.loading && visible.length === 0 && !lv.error && <p class="hint">{open.length && lv.filters.length ? 'No open issue matches these filters.' : 'No open issues here.'}</p>}
      {visible.length > 0 && <IssueLayout issues={visible} page={page} showAssignee={lv.source.kind !== 'assigned'} />}
    </div>
  );
};

const ProjectRow = ({ project }: { project: LinearProject }) => {
  const { linear } = usePlanner();
  const lv = useLinear();
  const workspace = workspaceLabel(lv, project.workspaceId);
  return (
    <li>
      <button class="project-row" onClick={() => void linear.openProject(project)} aria-label={`Open project ${project.name}`}>
        <span class="project-dot" style={{ '--item-color': project.color }} aria-hidden="true" />
        <span class="project-main">
          <span class="project-name">{project.name}</span>
          <span class="issue-meta">
            {workspace && <span class="ws-badge">{workspace}</span>}
            <span>{project.status.name}</span>
            {project.health && <span class={`health is-${project.health}`}>{HEALTH_LABELS[project.health]}</span>}
            {project.lead && <span>Lead {project.lead.name}</span>}
            {project.targetDate && <span>Target {monthDay(project.targetDate)}</span>}
            {project.teams.nodes.length > 0 && <span>{project.teams.nodes.map((team) => team.key).join(', ')}</span>}
          </span>
        </span>
        <Progress value={project.progress} />
      </button>
    </li>
  );
};

const ProjectOverview = ({ detail }: { detail: LinearProjectDetail }) => {
  const { host } = usePlanner();
  const milestones = [...detail.projectMilestones.nodes].sort((a, b) => a.sortOrder - b.sortOrder);
  const update = detail.lastUpdate;
  if (!update && milestones.length === 0 && !detail.content?.trim()) return <p class="hint">This project has no updates, milestones or description yet.</p>;
  return (
    <div class="project-overview">
      {update && (
        <section aria-label="Latest update">
          <h3>
            Latest update
            <span class={`health is-${update.health}`}>{HEALTH_LABELS[update.health] ?? update.health}</span>
            <span class="count">{update.user.name} · {new Date(update.createdAt).toLocaleDateString()}</span>
            <button class="link" onClick={() => void host.openUrl(update.url)}>Open</button>
          </h3>
          <p class="pre">{excerpt(update.body, 1500)}</p>
        </section>
      )}
      {milestones.length > 0 && (
        <section aria-label="Milestones">
          <h3>Milestones</h3>
          <ul class="milestones">
            {milestones.map((milestone) => (
              <li key={milestone.id}>
                <span class="milestone-name">{milestone.name}</span>
                {milestone.targetDate && <span class="muted">{monthDay(milestone.targetDate)}</span>}
                <Progress value={milestone.progress} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {detail.content?.trim() && (
        <section aria-label="Description">
          <h3>Description</h3>
          <p class="pre">{excerpt(detail.content, 5000)}</p>
        </section>
      )}
    </div>
  );
};

/** One project: its facts, then its open issues (to plan) or its overview. */
const ProjectDetail = ({ open }: { open: OpenProject }) => {
  const { linear, host } = usePlanner();
  const lv = useLinear();
  const view = useView();
  const [tab, setTab] = useState<'issues' | 'overview'>('issues');
  // A project's issues have filters of their own, gone when the project closes.
  const [filters, setFilters] = useState<LinearFilterRule[]>([]);
  const project = open.detail ?? open.project;
  const workspace = workspaceLabel(lv, project.workspaceId);
  const all = (open.detail?.issues.nodes ?? []).filter((issue) => !isClosedType(issue.state.type));
  const issues = filterIssues(all, filters, { today: view.today, workspaceNames: workspaceNames(lv) });
  return (
    <div class="project-detail" aria-label={`Project ${project.name}`}>
      <div class="linear-toolbar">
        <button class="link" onClick={() => linear.closeProject()}>← All projects</button>
        <span class="grow" />
        <button class="link" onClick={() => void host.openUrl(project.url)}>Open in Linear</button>
      </div>
      <header class="project-head">
        <span class="project-dot" style={{ '--item-color': project.color }} aria-hidden="true" />
        <h2>{project.name}</h2>
        {workspace && <span class="ws-badge">{workspace}</span>}
      </header>
      {project.description && <p class="project-summary">{project.description}</p>}
      <dl class="facts project-facts">
        <dt>Status</dt>
        <dd><span class="project-status" style={{ '--item-color': project.status.color }}>{project.status.name}</span></dd>
        <dt>Progress</dt>
        <dd><Progress value={project.progress} /></dd>
        {project.health && (<><dt>Health</dt><dd class={`health is-${project.health}`}>{HEALTH_LABELS[project.health]}</dd></>)}
        <dt>Lead</dt>
        <dd>{project.lead?.name ?? 'No lead'}</dd>
        {(project.startDate || project.targetDate) && (<><dt>Dates</dt><dd>{project.startDate ? monthDay(project.startDate) : 'No start'} → {project.targetDate ? monthDay(project.targetDate) : 'no target'}</dd></>)}
        {project.teams.nodes.length > 0 && (<><dt>Teams</dt><dd>{project.teams.nodes.map((team) => `${team.key} · ${team.name}`).join(', ')}</dd></>)}
      </dl>
      <div class="tabs project-tabs" role="tablist" aria-label="Project">
        <button role="tab" aria-selected={tab === 'issues'} onClick={() => setTab('issues')}>Issues{open.detail ? ` ${all.length}` : ''}</button>
        <button role="tab" aria-selected={tab === 'overview'} onClick={() => setTab('overview')}>Overview</button>
      </div>
      {open.loading && <p class="hint">Loading the project…</p>}
      {open.error && <p class="feed-errors" role="alert">{open.error}</p>}
      {open.detail && tab === 'issues' && all.length > 0 && <FilterBar issues={all} filters={filters} onChange={setFilters} />}
      {open.detail && tab === 'issues' && <FilterCount shown={issues.length} total={all.length} filtered={filters.length > 0} />}
      {open.detail && tab === 'issues' && (issues.length ? <IssueLayout issues={issues} page showAssignee /> : <p class="hint">{all.length ? 'No open issue matches these filters.' : 'No open issues in this project.'}</p>)}
      {open.detail && tab === 'overview' && <ProjectOverview detail={open.detail} />}
    </div>
  );
};

/** Linear projects of the shown workspaces, the active ones first. */
const ProjectsView = () => {
  const { linear } = usePlanner();
  const lv = useLinear();
  if (needsConnect(lv)) return <ConnectLinear />;
  if (lv.project) return <ProjectDetail key={lv.project.project.id} open={lv.project} />;
  const groups = groupProjects(lv.projects);
  return (
    <div class="linear-projects">
      <div class="linear-toolbar">
        <span class="grow muted">{lv.projectsLoaded ? `${lv.projects.length} open project${lv.projects.length === 1 ? '' : 's'}` : ''}</span>
        <button class="icon-button" aria-label="Refresh projects" onClick={() => void linear.loadProjects()}>↻</button>
      </div>
      <LinearErrors />
      {lv.projectsLoading && lv.projects.length === 0 && <p class="hint">Loading projects…</p>}
      {!lv.projectsLoading && lv.projectsLoaded && lv.projects.length === 0 && <p class="hint">No open projects here.</p>}
      {groups.map((group) => (
        <section key={group.type} class="issue-group" aria-label={`${group.label} projects`}>
          <h3>{group.label} <span class="count">{group.projects.length}</span></h3>
          <ul class="project-list">{group.projects.map((project) => <ProjectRow key={`${project.workspaceId}:${project.id}`} project={project} />)}</ul>
        </section>
      ))}
    </div>
  );
};

const PlannedRow = ({ task }: { task: Task }) => {
  const { linear } = usePlanner();
  const view = useView();
  const lv = useLinear();
  const { setUi } = useUi();
  const source = task.source!;
  const live = lv.linked[source.id];
  const status = live ? live.state : source.status;
  const workspace = workspaceLabel(lv, linear.workspaceOf(source));
  return (
    <li class="issue-row is-planned" aria-label={`${source.key} ${task.title}`}>
      <span class="issue-state" style={{ '--item-color': status?.color ?? '#5e6ad2' }} title={status?.name} aria-hidden="true" />
      <span class="issue-main">
        <button class="issue-title is-openable" aria-label={`Edit ${source.key}`} title="Open the issue" onClick={() => setUi({ openIssue: { id: source.id, workspaceId: linear.workspaceOf(source) } })}>{task.title}</button>
        <span class="issue-meta">
          <span class="issue-key">{source.key}</span>
          {workspace && <span class="ws-badge">{workspace}</span>}
          {status && <span>{status.name}</span>}
        </span>
      </span>
      <button class="link issue-planned" onClick={() => setUi({ openTaskId: task.id })} aria-label={`Open the task for ${source.key} (${plannedLabel(task, view.today)})`}>
        {plannedLabel(task, view.today)}
      </button>
    </li>
  );
};

/** Linear issues already in the plan, by when they are planned. */
const PlannedView = () => {
  const view = useView();
  const groups = plannedLinearTasks(view.state, view.today);
  if (groups.length === 0) return <p class="hint">No Linear issues in your plan yet. Plan one from Issues or Projects.</p>;
  return (
    <div class="linear-issues">
      {groups.map((group) => (
        <section key={group.key} class="issue-group" aria-label={`Planned ${group.label}`}>
          <h3>{group.label} <span class="count">{group.tasks.length}</span></h3>
          <ul class="issue-list">{group.tasks.map((task) => <PlannedRow key={task.id} task={task} />)}</ul>
        </section>
      ))}
    </div>
  );
};

/** Linear as a full page: issues, projects and the planned issues, across workspaces. */
export const LinearPage = () => {
  const { linear } = usePlanner();
  const lv = useLinear();
  const view = useView();
  const wide = issueDisplay(lv, view.state.settings).linearLayout === 'board' && (lv.mode === 'issues' || (lv.mode === 'projects' && Boolean(lv.project)));
  const sub =
    lv.workspaces.length > 1
      ? `${lv.workspaces.length} workspaces: ${lv.workspaces.map((workspace) => workspace.name).join(', ')}`
      : lv.workspaces[0]
        ? `${lv.workspaces[0].name} · ${lv.workspaces[0].account}`
        : lv.connected === false
          ? 'Not connected'
          : 'Checking the connection…';
  return (
    <section class="view">
      <header class="view-header">
        <h1>Linear</h1>
        <span class="view-sub">{sub}</span>
      </header>
      <div class="linear-modes">
        <div class="tabs" role="tablist" aria-label="Linear">
          {MODES.map((mode) => <button key={mode.id} role="tab" aria-selected={lv.mode === mode.id} onClick={() => linear.setMode(mode.id)}>{mode.label}</button>)}
        </div>
        <WorkspaceSelect />
      </div>
      <div class={`view-scroll linear-page${wide ? ' is-wide' : ''}`}>
        {lv.mode === 'issues' && (
          <>
            <p class="hint">Plan an issue for today, tomorrow or later, or drag it onto a day or the calendar. Planned issues become tasks linked to Linear.</p>
            <LinearIssues page />
          </>
        )}
        {lv.mode === 'projects' && <ProjectsView />}
        {lv.mode === 'planned' && <PlannedView />}
      </div>
    </section>
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
