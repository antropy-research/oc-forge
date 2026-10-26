// Linear's filters for a list: a Filter button (and F) opens a menu of
// properties, then of values with ticks; typing finds values of any property
// at once. Each rule is a chip, "Status | is either of | Todo, In Progress",
// whose operator and values can be changed; the choices come from the
// workspaces (every state, person, label, project and cycle), and the rules go
// to Linear, which answers with every matching issue.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { monthDay } from '../../../src/domain/dates.ts';
import {
  FILTER_FIELD_LABELS,
  LINEAR_FILTER_FIELDS,
  describeRule,
  filterChoices,
  operatorLabel,
  operatorsFor,
  searchChoices,
  toggleValue,
  withOperator,
  type FilterOption,
  type FilterOp,
  type LinearFilterField,
  type LinearFilterRule,
} from '../../../src/domain/linearFilter.ts';
import { useLinear, usePlanner } from '../../lib/context.ts';
import type { ListId } from '../../lib/linear.ts';
import { Avatar, CycleIcon, Dot, PriorityIcon, ProjectIcon, StatusIcon } from './icons.tsx';
import { Picker, useDismiss, type PickerOption } from './Picker.tsx';

const FIELD_ICONS: Record<LinearFilterField, string> = { status: '◌', assignee: '◍', creator: '✎', priority: '▮', label: '◆', project: '▣', team: '⌂', cycle: '↻', due: '◷', workspace: '◫' };

/** An option's icon, as Linear draws it. */
export const optionIcon = (option: FilterOption) => {
  switch (option.kind) {
    case 'state':
      return <StatusIcon type={option.type ?? ''} color={option.color ?? 'var(--oc-muted)'} />;
    case 'priority':
      return <PriorityIcon priority={option.priority ?? 0} />;
    case 'person':
      return <Avatar name={option.value ? option.label : null} size={16} />;
    case 'label':
      return <Dot color={option.color} />;
    case 'project':
      return <ProjectIcon color={option.value ? option.color : null} />;
    case 'cycle':
      return <CycleIcon />;
    default:
      return null;
  }
};

const valuesText = (rule: LinearFilterRule): string => {
  if (rule.values.length <= 3) return rule.values.map((item) => item.label).join(', ');
  return `${rule.values.slice(0, 2).map((item) => item.label).join(', ')} +${rule.values.length - 2}`;
};

type Stage = { kind: 'fields' } | { kind: 'values'; field: LinearFilterField; from: 'menu' | 'chip' } | { kind: 'date'; op: 'before' | 'after'; from: 'menu' | 'chip' } | { kind: 'op'; field: LinearFilterField };

/** The choices of a property for this list: from the catalogs of its workspaces, its teams first. */
const useChoices = (listId: ListId) => {
  const { linear } = usePlanner();
  const lv = useLinear();
  const list = lv.lists[listId];
  const workspaceIds = linear.workspacesOf(list);
  const catalogs = workspaceIds.map((id) => lv.catalogs[id]).filter((catalog): catalog is NonNullable<typeof catalog> => Boolean(catalog));
  const teamIds = list.view?.team ? [list.view.team.id] : [];
  const names = new Map(lv.workspaces.map((workspace) => [workspace.id, workspace.name]));
  const loading = workspaceIds.some((id) => !lv.catalogs[id]);
  return {
    loading,
    load: () => linear.loadCatalogs(workspaceIds),
    choices: (field: LinearFilterField): FilterOption[] => filterChoices(field, catalogs, { teamIds, workspaceNames: names }),
    fields: LINEAR_FILTER_FIELDS.filter((field) => field !== 'workspace' || (lv.workspaces.length > 1 && list.source.kind !== 'view' && list.source.kind !== 'project')),
  };
};

/** "Due date before / after" a date. */
const DueDateForm = ({ op, rules, onChange, onClose }: { op: 'before' | 'after'; rules: LinearFilterRule[]; onChange: (rules: LinearFilterRule[]) => void; onClose: () => void }) => {
  const root = useRef<HTMLDivElement>(null);
  const current = rules.find((rule) => rule.field === 'due');
  const [date, setDate] = useState(current && current.op === op ? current.values[0]?.value ?? '' : '');
  useDismiss(root, onClose);
  const apply = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    onChange([...rules.filter((rule) => rule.field !== 'due'), { field: 'due', op, values: [{ value: date, label: monthDay(date) }] }]);
    onClose();
  };
  return (
    <div class="lin-popover lin-filter-menu is-small" role="dialog" aria-label={`Due date ${op}`} ref={root} onKeyDown={(event) => event.stopPropagation()}>
      <div class="lin-popover-title">Due date {op}</div>
      <div class="lin-date-row">
        <input
          type="date"
          aria-label={`Due date ${op}`}
          value={date}
          ref={(element) => {
            if (element && document.activeElement !== element && !date) element.focus();
          }}
          onInput={(event) => setDate(event.currentTarget.value)}
          onKeyDown={(event) => event.key === 'Enter' && apply()}
        />
        <button type="button" class="lin-button is-primary" disabled={!date} onClick={apply}>Apply</button>
      </div>
    </div>
  );
};

const FilterMenu = ({ listId, rules, start, onChange, onClose }: { listId: ListId; rules: LinearFilterRule[]; start: Stage; onChange: (rules: LinearFilterRule[]) => void; onClose: () => void }) => {
  const [stage, setStage] = useState<Stage>(start);
  const [term, setTerm] = useState('');
  const { choices, fields, load, loading } = useChoices(listId);
  useEffect(() => void load(), []);

  const ruleOf = (field: LinearFilterField) => rules.find((rule) => rule.field === field);
  const toggle = (field: LinearFilterField, option: FilterOption) => onChange(toggleValue(rules, field, option));

  if (stage.kind === 'fields') {
    // Typing a value's name offers it directly, as Linear's quick filters do.
    const quick: PickerOption[] = term.trim()
      ? fields
          .filter((field) => field !== 'due')
          .flatMap((field) =>
            searchChoices(choices(field), term)
              .slice(0, 8)
              .map((option) => ({ value: `${field}|${option.value}`, label: option.label, hint: option.hint, icon: optionIcon(option), group: FILTER_FIELD_LABELS[field] })),
          )
          .slice(0, 40)
      : [];
    const fieldOptions: PickerOption[] = searchChoices(
      fields.map((field) => ({ value: field, label: FILTER_FIELD_LABELS[field], icon: <span class="lin-field-icon">{FIELD_ICONS[field]}</span>, hint: ruleOf(field) ? 'in use' : undefined })),
      term,
    ).map((option) => ({ ...option, group: term.trim() ? 'Filter by' : undefined }));
    return (
      <Picker
        key="fields"
        class="lin-filter-menu"
        label="Filter"
        placeholder="Filter…"
        options={[...fieldOptions, ...quick]}
        onSearch={setTerm}
        empty={loading ? 'Loading…' : 'No matches'}
        onClose={onClose}
        onPick={(option) => {
          const [field, value] = option.value.split('|') as [LinearFilterField, string | undefined];
          if (value === undefined) {
            setStage({ kind: 'values', field, from: 'menu' });
            return;
          }
          const found = choices(field).find((item) => item.value === value);
          if (found) toggle(field, found);
          onClose();
        }}
      />
    );
  }

  if (stage.kind === 'op') {
    const rule = ruleOf(stage.field);
    const count = rule?.values.length ?? 1;
    return (
      <Picker
        key="op"
        class="lin-filter-menu is-small"
        label={`${FILTER_FIELD_LABELS[stage.field]} filter operator`}
        placeholder="Change operator…"
        options={operatorsFor(stage.field).map((op) => ({ value: op, label: operatorLabel(op, count) }))}
        selected={rule ? [rule.op] : []}
        onClose={onClose}
        onPick={(option) => {
          const op = option.value as FilterOp;
          if (!rule) return onClose();
          if (stage.field === 'due' && (op === 'before' || op === 'after') && rule.op === 'is') {
            setStage({ kind: 'date', op, from: 'chip' });
            return;
          }
          onChange(rules.map((item) => (item.field === stage.field ? withOperator(item, op) : item)).filter((item) => item.values.length > 0));
          onClose();
        }}
      />
    );
  }

  if (stage.kind === 'date') return <DueDateForm op={stage.op} rules={rules} onChange={onChange} onClose={onClose} />;

  const field = stage.field;
  const rule = ruleOf(field);
  const options = choices(field);
  // A value chosen earlier that the workspace no longer offers still shows, so it can be unticked.
  const missing = (rule?.values ?? []).filter((item) => !options.some((option) => option.value === item.value) && !/^\d{4}-/.test(item.value));
  const listed: FilterOption[] = [...options, ...missing.map((item): FilterOption => ({ value: item.value, label: item.label, ...(item.color ? { color: item.color } : {}) }))];
  const all: PickerOption[] = listed.map((option) => ({ value: option.value, label: option.label, hint: option.hint, icon: optionIcon(option) }));
  if (field === 'due') all.push({ value: '@before', label: 'Before a date…', sticky: true }, { value: '@after', label: 'After a date…', sticky: true });
  return (
    <Picker
      key={`values:${field}`}
      class="lin-filter-menu"
      label={`Filter by ${FILTER_FIELD_LABELS[field]}`}
      placeholder={`${FILTER_FIELD_LABELS[field]}…`}
      options={all}
      multi
      selected={rule && rule.op !== 'before' && rule.op !== 'after' ? rule.values.map((item) => item.value) : []}
      empty={loading ? 'Loading…' : 'No matches'}
      onBack={stage.from === 'menu' ? () => setStage({ kind: 'fields' }) : undefined}
      onClose={onClose}
      footer={
        <span class="lin-popover-help">
          {stage.from === 'menu' && <button type="button" class="link" onClick={() => setStage({ kind: 'fields' })}>← Filters</button>}
          <span class="grow" />
          <span class="muted">↑↓ move · Enter tick · Esc close</span>
        </span>
      }
      onPick={(option) => {
        if (option.value === '@before' || option.value === '@after') {
          setStage({ kind: 'date', op: option.value === '@before' ? 'before' : 'after', from: stage.from });
          return;
        }
        const found = options.find((item) => item.value === option.value) ?? missing.find((item) => item.value === option.value);
        if (!found) return;
        // A date rule turns back into a choice of relative dates when one is ticked.
        const base = rule && (rule.op === 'before' || rule.op === 'after') ? rules.filter((item) => item.field !== 'due') : rules;
        onChange(toggleValue(base, field, found));
      }}
    />
  );
};

/** Filters of a list: chips, the Filter button and its menu, and Clear. `open` lets F open the menu. */
export const FilterBar = ({ listId, open, onOpenChange, compact = false }: { listId: ListId; open: boolean; onOpenChange: (open: boolean) => void; compact?: boolean }) => {
  const { linear } = usePlanner();
  const lv = useLinear();
  const rules = lv.lists[listId].filters;
  const [chipMenu, setChipMenu] = useState<{ field: LinearFilterField; what: 'op' | 'values' } | null>(null);
  const change = (next: LinearFilterRule[]) => linear.setFilters(next, listId);
  const closeMenu = useMemo(() => () => onOpenChange(false), [onOpenChange]);
  const closeChip = useMemo(() => () => setChipMenu(null), []);
  return (
    <div class={`lin-filters${compact ? ' is-compact' : ''}`} role="group" aria-label="Filters">
      {rules.map((rule) => {
        const text = describeRule(rule);
        const op = operatorLabel(rule.op, rule.values.length);
        return (
          <span key={rule.field} class="lin-chip" role="group" aria-label={text} title={text}>
            <span class="lin-chip-field">
              <span class="lin-field-icon" aria-hidden="true">{FIELD_ICONS[rule.field]}</span>
              {FILTER_FIELD_LABELS[rule.field]}
            </span>
            <span class="lin-anchor">
              <button type="button" class="lin-chip-op" aria-haspopup="listbox" aria-expanded={chipMenu?.field === rule.field && chipMenu.what === 'op'} aria-label={`Operator of ${FILTER_FIELD_LABELS[rule.field]}: ${op}`} onClick={() => setChipMenu({ field: rule.field, what: 'op' })}>
                {op}
              </button>
              {chipMenu?.field === rule.field && chipMenu.what === 'op' && <FilterMenu listId={listId} rules={rules} start={{ kind: 'op', field: rule.field }} onChange={change} onClose={closeChip} />}
            </span>
            <span class="lin-anchor">
              <button type="button" class="lin-chip-values" aria-haspopup="listbox" aria-expanded={chipMenu?.field === rule.field && chipMenu.what === 'values'} aria-label={`Edit filter: ${text}`} onClick={() => setChipMenu({ field: rule.field, what: 'values' })}>
                {valuesText(rule)}
              </button>
              {chipMenu?.field === rule.field && chipMenu.what === 'values' && (
                <FilterMenu
                  listId={listId}
                  rules={rules}
                  start={rule.op === 'before' || rule.op === 'after' ? { kind: 'date', op: rule.op, from: 'chip' } : { kind: 'values', field: rule.field, from: 'chip' }}
                  onChange={change}
                  onClose={closeChip}
                />
              )}
            </span>
            <button type="button" class="lin-chip-remove" aria-label={`Remove filter: ${text}`} onClick={() => change(rules.filter((item) => item.field !== rule.field))}>×</button>
          </span>
        );
      })}
      <span class="lin-anchor">
        <button type="button" class="lin-button lin-filter-button" aria-haspopup="dialog" aria-expanded={open} title="Filter (F)" onClick={() => onOpenChange(!open)}>
          <span aria-hidden="true">⚲</span> Filter
        </button>
        {open && <FilterMenu listId={listId} rules={rules} start={{ kind: 'fields' }} onChange={change} onClose={closeMenu} />}
      </span>
      {rules.length > 0 && <button type="button" class="link lin-clear" aria-label="Clear filters" onClick={() => change([])}>Clear</button>}
    </div>
  );
};

