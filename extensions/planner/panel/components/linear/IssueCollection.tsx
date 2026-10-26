// Issues the way Linear lays them out: one line per issue (priority, ID,
// status, title, then the chosen properties), in groups and sub-groups that
// fold; or a board whose columns are the groups (for status, each workflow
// state) with sub-groups as rows. Dropping a card on a column or row gives the
// issue that group's state, priority, assignee, project or cycle. ↑/↓ (or J/K)
// move through the issues, Enter opens one; more pages load at the end.
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { addDays, monthDay } from '../../../src/domain/dates.ts';
import { githubMirrors, isClosedType, linkedTask, type LinearIssue } from '../../../src/domain/linear.ts';
import { PRIORITY_NAMES, groupIssues, showsEmpty, sortIssues, type GroupTarget, type IssueDisplay, type IssueGroup } from '../../../src/domain/linearDisplay.ts';
import type { LinearProperty, Task } from '../../../src/domain/types.ts';
import { LINEAR_DRAG_TYPE, useLinear, usePlanner, useView } from '../../lib/context.ts';
import { useUi } from '../../lib/ui.ts';
import type { IssueRef, ListId } from '../../lib/linear.ts';
import { AssignButton } from '../AssigneePicker.tsx';
import { Avatar, CycleIcon, Dot, PriorityIcon, ProjectIcon, StatusIcon } from './icons.tsx';

/** Drag payload for moving an issue between groups: its workspace and id. */
export const BOARD_DRAG_TYPE = 'application/x-planner-linear-board';

const plannedLabel = (task: Task, today: string): string => {
  if (task.completedAt) return 'Done';
  if (task.placement.kind === 'backlog') return 'In backlog';
  if (task.placement.date === today) return 'Today';
  if (task.placement.date === addDays(today, 1)) return 'Tomorrow';
  return monthDay(task.placement.date);
};

const shortDate = (iso: string | undefined): string => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');

/** Plan the issue today, tomorrow or later, or hand it to an agent; once planned, open its task. */
export const PlanActions = ({ issue, compact = false }: { issue: LinearIssue; compact?: boolean }) => {
  const { linear, client } = usePlanner();
  const view = useView();
  const { setUi } = useUi();
  const linked = linkedTask(view.state, issue.id, githubMirrors(issue));
  const stop = (event: Event) => event.stopPropagation();
  if (linked) {
    return (
      <button type="button" class="lin-planned" onClick={(event) => { stop(event); setUi({ openTaskId: linked.id }); }} title="Open the task" aria-label={`Open the task for ${issue.identifier} (${plannedLabel(linked, view.today)})`}>
        {plannedLabel(linked, view.today)}
      </button>
    );
  }
  /** Plan it today: the task its assignee works on (the picker asks for it once an agent is chosen). */
  const assign = async () => {
    const { bodies, taskId } = linear.importCommands(issue, { kind: 'day', date: view.today });
    await client.dispatch(bodies, { undo: `Planned ${issue.identifier}` });
    return taskId;
  };
  return (
    <span class={`lin-plan${compact ? ' is-compact' : ''}`} onClick={stop} onKeyDown={stop}>
      <button type="button" onClick={() => void linear.plan(issue, { kind: 'day', date: view.today })} aria-label={`Plan ${issue.identifier} today`} title="Plan today">Today</button>
      <button type="button" onClick={() => void linear.plan(issue, { kind: 'day', date: addDays(view.today, 1) })} aria-label={`Plan ${issue.identifier} tomorrow`} title="Plan tomorrow">Tmrw</button>
      <button type="button" onClick={() => void linear.plan(issue, { kind: 'backlog', bucket: 'next-weeks' })} aria-label={`Put ${issue.identifier} in the backlog`} title="Put it in the backlog">Later</button>
      <AssignButton taskId={null} prepare={assign} label={`Assign ${issue.identifier} to an agent`}>Agent</AssignButton>
    </span>
  );
};

const has = (properties: readonly LinearProperty[], property: LinearProperty) => properties.includes(property);

/** The properties after the title, as the display chooses them. */
const Properties = ({ issue, properties, workspace, board = false }: { issue: LinearIssue; properties: readonly LinearProperty[]; workspace: string | null; board?: boolean }) => {
  const view = useView();
  const overdue = issue.dueDate && issue.dueDate < view.today && !isClosedType(issue.state.type);
  return (
    <span class="lin-props">
      {board && has(properties, 'priority') && <PriorityIcon priority={issue.priority} title={PRIORITY_NAMES[issue.priority]} />}
      {has(properties, 'labels') && (issue.labels?.nodes ?? []).slice(0, board ? 2 : 3).map((label) => (
        <span key={label.id} class="lin-pill"><Dot color={label.color} />{label.name}</span>
      ))}
      {has(properties, 'labels') && (issue.labels?.nodes.length ?? 0) > (board ? 2 : 3) && <span class="lin-pill">+{(issue.labels?.nodes.length ?? 0) - (board ? 2 : 3)}</span>}
      {has(properties, 'project') && issue.project && <span class="lin-pill" title="Project"><ProjectIcon color={issue.project.color} />{issue.project.name}</span>}
      {has(properties, 'cycle') && issue.cycle && <span class="lin-pill" title="Cycle"><CycleIcon />{issue.cycle.name || `Cycle ${issue.cycle.number}`}</span>}
      {has(properties, 'estimate') && issue.estimate != null && <span class="lin-pill" title="Estimate">◇ {issue.estimate}</span>}
      {has(properties, 'due') && issue.dueDate && <span class={`lin-pill${overdue ? ' is-overdue' : ''}`} title={`Due ${issue.dueDate}`}>◷ {monthDay(issue.dueDate)}</span>}
      {workspace && <span class="ws-badge">{workspace}</span>}
      {has(properties, 'created') && !board && <span class="lin-date" title={`Created ${issue.createdAt ?? ''}`}>{shortDate(issue.createdAt)}</span>}
      {has(properties, 'updated') && !board && <span class="lin-date" title={`Updated ${issue.updatedAt}`}>{shortDate(issue.updatedAt)}</span>}
      {has(properties, 'assignee') && !board && <Avatar name={issue.assignee?.name} />}
    </span>
  );
};

/** Open an issue in the issue view. */
const useOpen = () => {
  const { setUi } = useUi();
  return (issue: LinearIssue) => setUi({ openIssue: { id: issue.id, workspaceId: issue.workspaceId ?? null } });
};

const dragStart = (issue: LinearIssue) => (event: DragEvent) => {
  event.dataTransfer?.setData(LINEAR_DRAG_TYPE, JSON.stringify(issue));
  event.dataTransfer?.setData(BOARD_DRAG_TYPE, `${issue.workspaceId ?? ''}:${issue.id}`);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove';
};

/** One issue on one line, as in Linear's lists. */
export const LinearRow = ({ issue, properties, workspace }: { issue: LinearIssue; properties: readonly LinearProperty[]; workspace: string | null }) => {
  const lv = useLinear();
  const open = useOpen();
  return (
    <li
      class={`lin-row${lv.moving.has(issue.id) ? ' is-moving' : ''}`}
      data-issue-row={issue.id}
      tabIndex={0}
      draggable
      aria-label={`${issue.identifier} ${issue.title}`}
      onDragStart={dragStart(issue)}
      onClick={() => open(issue)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target === event.currentTarget) {
          event.preventDefault();
          open(issue);
        }
      }}
    >
      {has(properties, 'priority') && <PriorityIcon priority={issue.priority} title={PRIORITY_NAMES[issue.priority]} />}
      {has(properties, 'id') && <span class="lin-row-id">{issue.identifier}</span>}
      {has(properties, 'status') && <StatusIcon type={issue.state.type} color={issue.state.color} title={issue.state.name} />}
      <span class="lin-row-title">
        <span class="lin-title-text" role="button" tabIndex={-1} aria-label={`Edit ${issue.identifier}`}>{issue.title}</span>
        {issue.parent && <span class="lin-row-parent" title={`Sub-issue of ${issue.parent.identifier}`}>› {issue.parent.title}</span>}
      </span>
      <Properties issue={issue} properties={properties} workspace={workspace} />
      <PlanActions issue={issue} />
    </li>
  );
};

/** One issue as a board card. */
const LinearCard = ({ issue, properties, workspace }: { issue: LinearIssue; properties: readonly LinearProperty[]; workspace: string | null }) => {
  const lv = useLinear();
  const open = useOpen();
  return (
    <li
      class={`lin-card${lv.moving.has(issue.id) ? ' is-moving' : ''}`}
      data-issue-row={issue.id}
      tabIndex={0}
      draggable
      aria-label={`${issue.identifier} ${issue.title}`}
      onDragStart={dragStart(issue)}
      onClick={() => open(issue)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target === event.currentTarget) {
          event.preventDefault();
          open(issue);
        }
      }}
    >
      <div class="lin-card-top">
        {has(properties, 'id') && <span class="lin-row-id">{issue.identifier}</span>}
        <span class="grow" />
        {has(properties, 'assignee') && <Avatar name={issue.assignee?.name} />}
      </div>
      <div class="lin-card-title">
        {has(properties, 'status') && <StatusIcon type={issue.state.type} color={issue.state.color} title={issue.state.name} />}
        <span class="lin-title-text" role="button" tabIndex={-1} aria-label={`Edit ${issue.identifier}`}>{issue.title}</span>
      </div>
      <Properties issue={issue} properties={properties} workspace={workspace} board />
      <PlanActions issue={issue} compact />
    </li>
  );
};

const GroupHead = ({ group, more, folded = false, onFold, sub = false }: { group: IssueGroup; more: boolean; folded?: boolean; onFold?: () => void; sub?: boolean }) => (
  <h3 class={`lin-group-head${sub ? ' is-sub' : ''}`}>
    {onFold && <button type="button" class="lin-fold" aria-expanded={!folded} aria-label={`${folded ? 'Show' : 'Hide'} ${group.label}`} onClick={onFold}>{folded ? '▸' : '▾'}</button>}
    {group.stateType ? <StatusIcon type={group.stateType} color={group.color ?? 'var(--oc-muted)'} /> : group.target?.kind === 'priority' ? <PriorityIcon priority={group.target.priority} /> : group.target?.kind === 'assignee' ? <Avatar name={group.target.id ? group.label : null} size={16} /> : group.color ? <Dot color={group.color} /> : null}
    <span class="lin-group-name">{group.label}</span>
    <span class="count">{group.issues.length}{more ? '+' : ''}</span>
  </h3>
);

/** Where a dragged card would land, and what it would change. */
const useDrop = (issues: readonly LinearIssue[], listId: ListId) => {
  const { linear } = usePlanner();
  const [over, setOver] = useState<string | null>(null);
  const props = (key: string, targets: (GroupTarget | undefined)[]) => {
    const usable = targets.filter((target): target is GroupTarget => Boolean(target));
    if (!usable.length) return {};
    return {
      onDragOver: (event: DragEvent) => {
        if (!event.dataTransfer?.types.includes(BOARD_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (over !== key) setOver(key);
      },
      onDragLeave: (event: DragEvent) => {
        if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) setOver(null);
      },
      onDrop: async (event: DragEvent) => {
        event.preventDefault();
        setOver(null);
        const data = event.dataTransfer?.getData(BOARD_DRAG_TYPE) ?? '';
        const issue = issues.find((item) => `${item.workspaceId ?? ''}:${item.id}` === data);
        if (!issue) return;
        let current: LinearIssue = issue;
        for (const target of usable) {
          await linear.moveToGroup(current, target);
          current = linear.getView().lists[listId].issues.find((item) => item.id === issue.id) ?? current;
        }
      },
    };
  };
  return { over, props };
};

/** Move focus between issues with ↑/↓ or J/K. */
const onListKeys = (event: KeyboardEvent) => {
  const keys: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, j: 1, k: -1 };
  const delta = keys[event.key];
  if (!delta || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement;
  if (!target.matches('[data-issue-row]')) return;
  const rows = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[data-issue-row]')];
  const next = rows[rows.indexOf(target) + delta];
  if (!next) return;
  event.preventDefault();
  next.focus();
};

/** The end of a list: Linear has more, so read on when it comes into view, or on a click. */
const More = ({ listId, count }: { listId: ListId; count: number }) => {
  const { linear } = usePlanner();
  const lv = useLinear();
  const list = lv.lists[listId];
  const sentinel = useRef<HTMLDivElement>(null);
  const hasMore = Object.keys(list.more).length > 0;
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && void linear.loadMore(listId), { rootMargin: '200px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore, count, linear, listId]);
  if (!hasMore) return count > 0 ? <p class="lin-end" aria-live="polite">{count} issue{count === 1 ? '' : 's'}</p> : null;
  return (
    <div class="lin-more" ref={sentinel}>
      <span class="muted" aria-live="polite">{count} loaded · Linear has more</span>
      <button type="button" class="lin-button" disabled={list.loadingMore} onClick={() => void linear.loadMore(listId)}>{list.loadingMore ? 'Loading…' : 'Load more'}</button>
    </div>
  );
};

/**
 * A list's issues, grouped, ordered and laid out as its display says. Status
 * groups are the teams' exact workflow states; on a board, empty columns
 * show when the display shows empty groups, so a card can be dropped there.
 */
export const IssueCollection = ({ listId, issues, display, footer }: { listId: ListId; issues: LinearIssue[]; display: IssueDisplay; footer?: ComponentChildren }) => {
  const { linear } = usePlanner();
  const lv = useLinear();
  const list = lv.lists[listId];
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const names = useMemo(() => new Map(lv.workspaces.map((workspace) => [workspace.id, workspace.name])), [lv.workspaces]);
  const several = lv.workspaces.length > 1;
  const states = linear.statesForTeams(linear.teamsOf(list));
  const more = Object.keys(list.more).length > 0;
  const sorted = useMemo(() => sortIssues(issues, display.orderBy, display.orderReverse), [issues, display.orderBy, display.orderReverse]);
  const context = { layout: display.layout, states, showEmpty: showsEmpty(display), workspaceNames: names };
  const groups = groupIssues(sorted, display.groupBy, context);
  const sub = display.subGroupBy !== 'none' && display.subGroupBy !== display.groupBy ? display.subGroupBy : null;
  const { over, props: dropProps } = useDrop(issues, listId);
  const toggle = (key: string) => setFolded((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  const workspaceOf = (issue: LinearIssue) => (several ? names.get(issue.workspaceId ?? '') ?? null : null);

  // The order shown, for J and K in the issue view.
  const shownOrder = groups.flatMap((group) => (folded.has(group.key) ? [] : sub ? groupIssues(group.issues, sub, { ...context, showEmpty: false }).flatMap((item) => item.issues) : group.issues));
  const orderKey = shownOrder.map((issue) => issue.id).join(',');
  useEffect(() => {
    if (listId === 'page') linear.setOrder(shownOrder.map((issue): IssueRef => ({ id: issue.id, workspaceId: issue.workspaceId ?? null })));
  }, [orderKey, listId, linear]);

  // Team states for empty columns, once.
  useEffect(() => {
    if (display.groupBy === 'status' && showsEmpty(display)) void linear.loadCatalogs(linear.workspacesOf(list));
  }, [display.groupBy, display.layout, display.showEmptyGroups, display.showEmptyColumns, list.source]);

  if (display.layout === 'board') {
    const rows = sub ? groupIssues(sorted, sub, { ...context, showEmpty: false }) : [null];
    return (
      <div class="lin-board-wrap">
        <div class="lin-board" onKeyDown={onListKeys} style={{ '--columns': String(Math.max(1, groups.length)) }}>
          {groups.map((group) => (
            <div key={`head:${group.key}`} class="lin-board-head">
              <GroupHead group={group} more={more} />
            </div>
          ))}
          {rows.map((row) => [
            row ? (
              <div key={`row:${row.key}`} class="lin-board-row-head">
                <GroupHead group={row} more={false} folded={folded.has(`row:${row.key}`)} onFold={() => toggle(`row:${row.key}`)} sub />
              </div>
            ) : null,
            ...(row && folded.has(`row:${row.key}`)
              ? []
              : groups.map((group) => {
                  const key = row ? `${row.key}|${group.key}` : group.key;
                  const cell = row ? group.issues.filter((issue) => row.issues.includes(issue)) : group.issues;
                  return (
                    <section key={`cell:${key}`} class={`board-column${over === key ? ' is-over' : ''}`} aria-label={row ? `${group.label} · ${row.label}` : group.label} {...dropProps(key, [group.target, row?.target])}>
                      <ul class="lin-cards">{cell.map((issue) => <LinearCard key={issue.id} issue={issue} properties={display.properties} workspace={workspaceOf(issue)} />)}</ul>
                      {cell.length === 0 && group.target && <p class="hint board-drop">Drop an issue here</p>}
                    </section>
                  );
                })),
          ])}
        </div>
        {footer}
        <More listId={listId} count={issues.length} />
      </div>
    );
  }

  return (
    <div class="lin-list" onKeyDown={onListKeys}>
      {groups.map((group) => (
        <section key={group.key} class={`lin-group${over === group.key ? ' is-over' : ''}`} aria-label={group.label} {...dropProps(group.key, [group.target])}>
          {display.groupBy !== 'none' && <GroupHead group={group} more={more} folded={folded.has(group.key)} onFold={() => toggle(group.key)} />}
          {!folded.has(group.key) &&
            (sub ? (
              groupIssues(group.issues, sub, { ...context, showEmpty: false }).map((item) => (
                <section key={`${group.key}|${item.key}`} class={`lin-subgroup${over === `${group.key}|${item.key}` ? ' is-over' : ''}`} aria-label={`${group.label} · ${item.label}`} {...dropProps(`${group.key}|${item.key}`, [group.target, item.target])}>
                  <GroupHead group={item} more={false} folded={folded.has(`${group.key}|${item.key}`)} onFold={() => toggle(`${group.key}|${item.key}`)} sub />
                  {!folded.has(`${group.key}|${item.key}`) && <ul class="lin-rows">{item.issues.map((issue) => <LinearRow key={issue.id} issue={issue} properties={display.properties} workspace={workspaceOf(issue)} />)}</ul>}
                </section>
              ))
            ) : (
              <ul class="lin-rows">{group.issues.map((issue) => <LinearRow key={issue.id} issue={issue} properties={display.properties} workspace={workspaceOf(issue)} />)}</ul>
            ))}
          {!folded.has(group.key) && group.issues.length === 0 && <p class="hint lin-empty-group">No issues</p>}
        </section>
      ))}
      {footer}
      <More listId={listId} count={issues.length} />
    </div>
  );
};
