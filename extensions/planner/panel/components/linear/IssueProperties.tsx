// The issue view's sidebar (IssueEditor.tsx): the issue's properties as Linear lays them out, each a searchable picker
// (S status, P priority, A assignee, L labels, Shift D due date: the issue view's keys open them), its links, and
// planning it. A change shows at once and goes to Linear through the issue view, which settles it with the answer.
import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { addDays, isDateKey, monthDay, startOfWeek } from '../../../src/domain/core/dates.ts';
import type { DateKey } from '../../../src/domain/core/types.ts';
import { estimateChoices, estimateLabel, githubMirrors, linkedTask, type IssueInput, type LinearIssueDetail, type LinearLabel, type LinearState, type TeamOptions } from '../../../src/domain/linear/linear.ts';
import { PRIORITY_NAMES } from '../../../src/domain/linear/display.ts';
import { usePlanner, useView } from '../../lib/core/context.ts';
import { useUi } from '../../lib/core/ui.ts';
import { when } from './common.tsx';
import { Avatar, CycleIcon, Dot, Kbd, PriorityIcon, ProjectIcon, StatusIcon } from './icons.tsx';
import { Picker, type PickerOption } from './Picker.tsx';

/** The property pickers of the issue view, with the keys that open them. */
export type Field = 'status' | 'priority' | 'assignee' | 'labels' | 'project' | 'cycle' | 'estimate' | 'due';

/** Changes on their way to Linear, shown at once. */
export interface Pending {
  state?: LinearState;
  priority?: number;
  assignee?: { id: string; name: string } | null;
  labels?: LinearLabel[];
  project?: { id: string; name: string; color?: string } | null;
  cycle?: { id: string; number: number; name?: string | null } | null;
  estimate?: number | null;
  dueDate?: string | null;
}

/** Plan the issue from the issue view, or open the task that already plans it. */
const PlanActions = ({ issue }: { issue: LinearIssueDetail }) => {
  const { linear } = usePlanner();
  const view = useView();
  const { setUi } = useUi();
  const task = linkedTask(view.state, issue.id, githubMirrors(issue));
  if (task && !task.completedAt) return <button class="lin-button" onClick={() => setUi({ openIssue: null, openTaskId: task.id })}>Open the task</button>;
  return (
    <span class="lin-plan is-visible">
      <button onClick={() => void linear.plan(issue, { kind: 'day', date: view.today })} aria-label={`Plan ${issue.identifier} today`}>Today</button>
      <button onClick={() => void linear.plan(issue, { kind: 'day', date: addDays(view.today, 1) })} aria-label={`Plan ${issue.identifier} tomorrow`}>Tmrw</button>
      <button onClick={() => void linear.plan(issue, { kind: 'backlog', bucket: 'next-weeks' })} aria-label={`Put ${issue.identifier} in the backlog`}>Later</button>
    </span>
  );
};

/** One property in the sidebar: its name, its value as a button, and the picker it opens. */
const Property = ({ name, value, icon, shortcut, open, onOpen, busy, children }: { name: string; value: string; icon?: ComponentChildren; shortcut?: string; open: boolean; onOpen: () => void; busy?: boolean; children?: ComponentChildren }) => (
  <div class="iv-prop">
    <span class="iv-prop-name">{name}</span>
    <span class="lin-anchor iv-prop-anchor">
      <button
        type="button"
        class={`iv-prop-value${busy ? ' is-busy' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${name}: ${value}`}
        title={shortcut ? `Change ${name.toLowerCase()} (${shortcut})` : `Change ${name.toLowerCase()}`}
        onClick={onOpen}
      >
        {icon}
        <span class="iv-prop-text">{value}</span>
      </button>
      {open && children}
    </span>
  </div>
);

/** The issue's sidebar: its properties (`picker` the one open), links, planning, and who made it when. */
export const IssueProperties = ({
  issue,
  options,
  optionsError,
  pending,
  busy,
  picker,
  setPicker,
  update,
}: {
  issue: LinearIssueDetail;
  options: TeamOptions | null;
  optionsError: string | null;
  pending: Pending;
  busy: string | null;
  picker: Field | null;
  setPicker: (field: Field | null) => void;
  /** Send a property change at once; it shows right away and settles with Linear's answer. */
  update: (field: Field, input: IssueInput, shown: Pending) => void;
}) => {
  const { linear, host } = usePlanner();
  const view = useView();
  const [dueText, setDueText] = useState('');
  const me = linear.viewerId(issue.workspaceId ?? null);

  // What the sidebar shows: Linear's values, or the change on its way.
  const state = pending.state ?? issue.state;
  const priority = pending.priority ?? issue.priority ?? 0;
  const assignee = 'assignee' in pending ? pending.assignee : issue.assignee ?? null;
  const labels = pending.labels ?? issue.labels.nodes ?? [];
  const project = 'project' in pending ? pending.project : issue.project ?? null;
  const cycle = 'cycle' in pending ? pending.cycle : issue.cycle ?? null;
  const estimate = 'estimate' in pending ? pending.estimate : issue.estimate ?? null;
  const dueDate = 'dueDate' in pending ? pending.dueDate : issue.dueDate ?? null;
  const estimates = options ? estimateChoices(options.estimation) : [];
  const close = useMemo(() => () => setPicker(null), []);

  const pick = (field: Field, input: IssueInput, shown: Pending) => {
    setPicker(null);
    update(field, input, shown);
  };

  const { today } = view;
  const weekStartsOn = view.state.settings.weekStartsOn;
  const day = (value: DateKey, label: string): PickerOption => ({ value, label, hint: monthDay(value) });
  const dueChoices: PickerOption[] = [
    day(today, 'Today'),
    day(addDays(today, 1), 'Tomorrow'),
    day(addDays(startOfWeek(today, weekStartsOn), weekStartsOn === 1 ? 4 : 5), 'End of this week'),
    day(addDays(today, 7), 'In one week'),
    day(addDays(today, 14), 'In two weeks'),
    ...(dueDate ? [{ value: '', label: 'Remove due date', sticky: true }] : []),
  ];
  const setDue = (value: string) => pick('due', { dueDate: isDateKey(value) ? value : null }, { dueDate: isDateKey(value) ? value : null });

  return (
    <aside class="iv-side" aria-label="Properties">
      {optionsError && <p class="hint">Couldn't load the team's states, people and labels: {optionsError}</p>}
      <div class="iv-props">
        <Property name="Status" value={state?.name ?? ''} icon={state && <StatusIcon type={state.type} color={state.color} />} shortcut="S" open={picker === 'status'} busy={busy === 'status'} onOpen={() => options && setPicker(picker === 'status' ? null : 'status')}>
          <Picker
            label="Change status"
            placeholder="Change status…"
            options={(options?.states ?? []).map((item) => ({ value: item.id, label: item.name, icon: <StatusIcon type={item.type} color={item.color} /> }))}
            selected={state ? [state.id] : []}
            onClose={close}
            onPick={(option) => {
              const chosen = options?.states.find((item) => item.id === option.value);
              if (chosen && chosen.id !== state?.id) pick('status', { stateId: chosen.id }, { state: chosen });
              else setPicker(null);
            }}
          />
        </Property>
        <Property name="Priority" value={PRIORITY_NAMES[priority] ?? 'No priority'} icon={<PriorityIcon priority={priority} />} shortcut="P" open={picker === 'priority'} busy={busy === 'priority'} onOpen={() => setPicker(picker === 'priority' ? null : 'priority')}>
          <Picker
            label="Change priority"
            placeholder="Change priority…"
            options={[0, 1, 2, 3, 4].map((value) => ({ value: String(value), label: PRIORITY_NAMES[value]!, icon: <PriorityIcon priority={value} /> }))}
            selected={[String(priority)]}
            onClose={close}
            onPick={(option) => (Number(option.value) !== priority ? pick('priority', { priority: Number(option.value) }, { priority: Number(option.value) }) : setPicker(null))}
          />
        </Property>
        <Property name="Assignee" value={assignee?.name ?? 'No assignee'} icon={<Avatar name={assignee?.name} />} shortcut="A" open={picker === 'assignee'} busy={busy === 'assignee'} onOpen={() => options && setPicker(picker === 'assignee' ? null : 'assignee')}>
          <Picker
            label="Assign to"
            placeholder="Assign to…"
            options={[
              { value: '', label: 'No assignee', icon: <Avatar name={null} size={16} /> },
              ...[...(options?.members ?? []), ...(assignee && !options?.members.some((member) => member.id === assignee.id) ? [{ id: assignee.id, name: assignee.name, displayName: '', active: true }] : [])]
                .sort((a, b) => Number(b.id === me) - Number(a.id === me))
                .map((member) => ({ value: member.id, label: member.name, hint: member.id === me ? 'You' : member.displayName || undefined, icon: <Avatar name={member.name} size={16} /> })),
            ]}
            selected={[assignee?.id ?? '']}
            onClose={close}
            onPick={(option) => {
              if ((assignee?.id ?? '') === option.value) return setPicker(null);
              pick('assignee', { assigneeId: option.value || null }, { assignee: option.value ? { id: option.value, name: option.label } : null });
            }}
          />
        </Property>
        <Property
          name="Labels"
          value={labels.length ? labels.map((label) => label.name).join(', ') : 'Add label'}
          icon={labels.length ? <span class="iv-label-dots">{labels.slice(0, 3).map((label) => <Dot key={label.id} color={label.color} />)}</span> : undefined}
          shortcut="L"
          open={picker === 'labels'}
          busy={busy === 'labels'}
          onOpen={() => options && setPicker(picker === 'labels' ? null : 'labels')}
        >
          <Picker
            label="Change labels"
            placeholder="Change labels…"
            multi
            options={(options?.labels ?? labels).map((label) => ({ value: label.id, label: label.name, icon: <Dot color={label.color} /> }))}
            selected={labels.map((label) => label.id)}
            onClose={close}
            onPick={(option) => {
              const on = labels.some((label) => label.id === option.value);
              const label = (options?.labels ?? labels).find((item) => item.id === option.value);
              if (!label) return;
              // Labels stay open for more ticks, as in Linear.
              update('labels', on ? { removedLabelIds: [label.id] } : { addedLabelIds: [label.id] }, { labels: on ? labels.filter((item) => item.id !== label.id) : [...labels, label] });
            }}
          />
        </Property>
        <Property name="Project" value={project?.name ?? 'No project'} icon={<ProjectIcon color={project?.color ?? null} />} open={picker === 'project'} busy={busy === 'project'} onOpen={() => options && setPicker(picker === 'project' ? null : 'project')}>
          <Picker
            label="Move to project"
            placeholder="Move to project…"
            options={[
              { value: '', label: 'No project', icon: <ProjectIcon color={null} /> },
              ...[...(options?.projects ?? []), ...(project && !options?.projects.some((item) => item.id === project.id) ? [{ id: project.id, name: project.name, color: project.color ?? '', icon: null }] : [])].map((item) => ({ value: item.id, label: item.name, icon: <ProjectIcon color={item.color} /> })),
            ]}
            selected={[project?.id ?? '']}
            onClose={close}
            onPick={(option) => {
              if ((project?.id ?? '') === option.value) return setPicker(null);
              const found = options?.projects.find((item) => item.id === option.value);
              pick('project', { projectId: option.value || null }, { project: option.value ? { id: option.value, name: option.label, color: found?.color } : null });
            }}
          />
        </Property>
        {(options?.cycles.length || cycle) && (
          <Property name="Cycle" value={cycle ? cycle.name || `Cycle ${cycle.number}` : 'No cycle'} icon={<CycleIcon />} open={picker === 'cycle'} busy={busy === 'cycle'} onOpen={() => options && setPicker(picker === 'cycle' ? null : 'cycle')}>
            <Picker
              label="Move to cycle"
              placeholder="Move to cycle…"
              options={[{ value: '', label: 'No cycle' }, ...(options?.cycles ?? []).map((item) => ({ value: item.id, label: item.name || `Cycle ${item.number}`, hint: item.isActive ? 'Current' : item.isNext ? 'Next' : `${monthDay(item.startsAt.slice(0, 10))} – ${monthDay(item.endsAt.slice(0, 10))}`, icon: <CycleIcon /> }))]}
              selected={[cycle?.id ?? '']}
              onClose={close}
              onPick={(option) => {
                if ((cycle?.id ?? '') === option.value) return setPicker(null);
                const found = options?.cycles.find((item) => item.id === option.value);
                pick('cycle', { cycleId: option.value || null }, { cycle: found ? { id: found.id, number: found.number, name: found.name } : null });
              }}
            />
          </Property>
        )}
        {estimates.length > 0 && (
          <Property name="Estimate" value={estimateLabel(estimate, options?.estimation)} icon={<span class="lin-field-icon" aria-hidden="true">◇</span>} open={picker === 'estimate'} busy={busy === 'estimate'} onOpen={() => setPicker(picker === 'estimate' ? null : 'estimate')}>
            <Picker
              label="Set estimate"
              placeholder="Set estimate…"
              options={[{ value: '', label: 'No estimate' }, ...estimates.map((item) => ({ value: String(item.value), label: item.label }))]}
              selected={[estimate === null || estimate === undefined ? '' : String(estimate)]}
              onClose={close}
              onPick={(option) => {
                const value = option.value === '' ? null : Number(option.value);
                if (value === (estimate ?? null)) return setPicker(null);
                pick('estimate', { estimate: value }, { estimate: value });
              }}
            />
          </Property>
        )}
        <Property name="Due date" value={dueDate ? monthDay(dueDate) : 'Set due date'} icon={<span class={`lin-field-icon${dueDate && dueDate < view.today ? ' is-overdue' : ''}`} aria-hidden="true">◷</span>} shortcut="Shift D" open={picker === 'due'} busy={busy === 'due'} onOpen={() => setPicker(picker === 'due' ? null : 'due')}>
          <Picker
            label="Change due date"
            placeholder="Change due date…"
            options={dueChoices}
            selected={dueDate ? [dueDate] : []}
            onClose={close}
            onPick={(option) => setDue(option.value)}
            footer={
              <span class="lin-date-row">
                <input type="date" aria-label="Issue due date" value={dueText || dueDate || ''} onInput={(event) => setDueText(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && isDateKey(dueText) && setDue(dueText)} />
                <button type="button" class="lin-button" disabled={!isDateKey(dueText)} onClick={() => setDue(dueText)}>Set</button>
              </span>
            }
          />
        </Property>
      </div>
      <section class="iv-side-section" aria-label="Links">
        <h3>Links</h3>
        {(issue.attachments?.nodes.length ?? 0) === 0 && <p class="hint">No links</p>}
        <ul class="iv-links">
          {(issue.attachments?.nodes ?? []).map((link) => (
            <li key={link.id}>
              <button type="button" class="iv-link" title={link.url} onClick={() => void host.openUrl(link.url)}>
                <span class="iv-link-title">{link.title}</span>
                {link.subtitle && <span class="muted">{link.subtitle}</span>}
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section class="iv-side-section" aria-label="Planner">
        <h3>Plan</h3>
        <PlanActions issue={issue} />
      </section>
      <p class="iv-side-meta muted">
        {issue.creator ? `Created by ${issue.creator.name}` : 'Created'}{issue.createdAt ? ` · ${when(issue.createdAt)}` : ''}
        <br />
        Updated {when(issue.updatedAt)}
      </p>
      <p class="iv-keys muted"><Kbd>S</Kbd> status <Kbd>P</Kbd> priority <Kbd>A</Kbd> assignee <Kbd>L</Kbd> labels <Kbd>⇧D</Kbd> due <Kbd>J</Kbd>/<Kbd>K</Kbd> next/previous</p>
    </aside>
  );
};
