// The Filter menu of Linear's filter bar (FilterBar.tsx): the properties first, then a property's values with ticks;
// typing finds values of any property at once, as Linear's quick filters do. A chip opens it on its rule's operator
// or values, the builder's "+ Add filter" on a new rule; a date or a text has a small form of its own. The choices
// come from the workspaces (every state, person, label, project, milestone and cycle).
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { monthDay } from '../../../src/domain/core/dates.ts';
import {
  FILTER_FIELD_LABELS,
  LINEAR_FILTER_FIELDS,
  appendIn,
  defaultOperator,
  filterChoices,
  isFilterRule,
  isSingleValued,
  nodeIn,
  operatorLabel,
  operatorsFor,
  partialNote,
  replaceIn,
  searchChoices,
  toggleRuleValue,
  withOperator,
  type FilterOp,
  type FilterOption,
  type FilterPath,
  type FilterValue,
  type LinearFilterField,
  type LinearFilterGroup,
  type LinearFilterRule,
} from '../../../src/domain/linear/filter.ts';
import { useLinear, usePlanner } from '../../lib/core/context.ts';
import type { ListId } from '../../lib/linear/types.ts';
import { workspaceNames } from './common.tsx';
import { Avatar, CycleIcon, Dot, PriorityIcon, ProjectIcon, StatusIcon } from './icons.tsx';
import { Picker, useDismiss, useKeepInView, type PickerOption } from './Picker.tsx';

export const FIELD_ICONS: Record<LinearFilterField, string> = {
  status: '◌',
  assignee: '◍',
  creator: '✎',
  priority: '▮',
  label: '◆',
  content: '≡',
  project: '▣',
  milestone: '⚑',
  team: '⌂',
  cycle: '↻',
  estimate: '◇',
  subscriber: '◉',
  relation: '⇄',
  due: '◷',
  created: '◷',
  updated: '◷',
  completed: '◷',
  workspace: '◫',
};

/** An option's icon, as Linear draws it. */
const optionIcon = (option: FilterOption) => {
  switch (option.kind) {
    case 'state':
      return <StatusIcon type={option.type ?? ''} color={option.color ?? 'var(--oc-muted)'} />;
    case 'priority':
      return <PriorityIcon priority={option.priority ?? 0} />;
    case 'person':
      return <Avatar name={option.value === '@me' ? option.hint ?? 'Me' : option.value ? option.label : null} size={16} />;
    case 'label':
      return <Dot color={option.color} />;
    case 'project':
      return <ProjectIcon color={option.value ? option.color : null} />;
    case 'cycle':
      return <CycleIcon />;
    case 'milestone':
      return <span class="lin-field-icon">{option.value ? '⚑' : '·'}</span>;
    case 'relation':
      return <span class="lin-field-icon">⇄</span>;
    default:
      return null;
  }
};

const DATED = /^\d{4}-\d{2}-\d{2}$/;
type DateField = 'due' | 'created' | 'updated' | 'completed';
const isDateField = (field: LinearFilterField): field is DateField => field === 'due' || field === 'created' || field === 'updated' || field === 'completed';
/** Properties with one value at a time, picked from a short list (or a date). */
const isPointField = (field: LinearFilterField) => field === 'created' || field === 'updated' || field === 'completed';

type Stage =
  | { kind: 'fields' }
  | { kind: 'values'; field: LinearFilterField; from: 'menu' | 'chip' }
  | { kind: 'date'; field: DateField; op: 'before' | 'after'; from: 'menu' | 'chip' }
  | { kind: 'text'; from: 'menu' | 'chip' }
  | { kind: 'op' };

/**
 * What a menu changes: the bar's Filter button (a value joins its property's
 * top-level rule, as in Linear's bar), one rule (a chip's operator or values),
 * or a new rule in a group of the builder (or a new group holding it).
 */
type Target = { kind: 'bar' } | { kind: 'rule'; path: FilterPath } | { kind: 'new'; parent: FilterPath; group: boolean };

/** The choices of a property for this list: from the catalogs of its workspaces, its teams first. */
const useChoices = (listId: ListId, inGroup: boolean) => {
  const { linear } = usePlanner();
  const lv = useLinear();
  const list = lv.lists[listId];
  const workspaceIds = linear.workspacesOf(list);
  const catalogs = workspaceIds.map((id) => lv.catalogs[id]).filter((catalog): catalog is NonNullable<typeof catalog> => Boolean(catalog));
  const teamIds = list.view?.team ? [list.view.team.id] : [];
  const names = workspaceNames(lv);
  const loading = workspaceIds.some((id) => !lv.catalogs[id]);
  return {
    loading,
    load: () => linear.loadCatalogs(workspaceIds),
    choices: (field: LinearFilterField): FilterOption[] => filterChoices(field, catalogs, { teamIds, workspaceNames: names }),
    /** Said under a property's values when Linear has more of them than the catalog read. */
    partial: (field: LinearFilterField): string | null => partialNote(field, catalogs),
    // The workspace picks which workspaces are read: a top-level filter of the bar only.
    fields: LINEAR_FILTER_FIELDS.filter((field) => field !== 'workspace' || (!inGroup && lv.workspaces.length > 1 && list.source.kind !== 'view' && list.source.kind !== 'project')),
  };
};

const ruleAt = (tree: LinearFilterGroup, path: FilterPath | null): LinearFilterRule | null => {
  const node = path ? nodeIn(tree, path) : null;
  return node && isFilterRule(node) ? node : null;
};

const freshRule = (field: LinearFilterField, option: FilterValue): LinearFilterRule => ({ field, op: defaultOperator(field), values: [{ value: option.value, label: option.label, ...(option.color ? { color: option.color } : {}) }] });

/** "Due date before / after" a date, or the same of the created, updated or completed date. */
const DateForm = ({ field, op, rule, onApply, onClose }: { field: DateField; op: 'before' | 'after'; rule: LinearFilterRule | null; onApply: (date: string) => void; onClose: () => void }) => {
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [date, setDate] = useState(rule && rule.op === op && DATED.test(rule.values[0]?.value ?? '') ? rule.values[0]!.value : '');
  useDismiss(root, onClose);
  useKeepInView(root);
  useLayoutEffect(() => input.current?.focus(), []);
  const label = `${FILTER_FIELD_LABELS[field]} ${op}`;
  const apply = () => {
    if (!DATED.test(date)) return;
    onApply(date);
    onClose();
  };
  return (
    <div class="lin-popover lin-filter-menu is-small" role="dialog" aria-label={label} ref={root} onKeyDown={(event) => event.stopPropagation()}>
      <div class="lin-popover-title">{label}</div>
      <div class="lin-date-row">
        <input ref={input} type="date" aria-label={label} value={date} onInput={(event) => setDate(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && apply()} />
        <button type="button" class="lin-button is-primary" disabled={!date} onClick={apply}>Apply</button>
      </div>
    </div>
  );
};

/** "Content contains" a text: in the title or the description, as Linear's content filter. */
const TextForm = ({ rule, onApply, onClose }: { rule: LinearFilterRule | null; onApply: (text: string) => void; onClose: () => void }) => {
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(rule?.values[0]?.value ?? '');
  useDismiss(root, onClose);
  useKeepInView(root);
  useLayoutEffect(() => input.current?.focus(), []);
  const label = `Content ${operatorLabel(rule?.op ?? 'contains', 1)}`;
  const apply = () => {
    onApply(text.trim());
    onClose();
  };
  return (
    <div class="lin-popover lin-filter-menu is-small" role="dialog" aria-label="Filter by Content" ref={root} onKeyDown={(event) => event.stopPropagation()}>
      <div class="lin-popover-title">{label}</div>
      <div class="lin-date-row">
        <input ref={input} type="search" aria-label={label} placeholder="Text in the title or description" value={text} onInput={(event) => setText(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && apply()} />
        <button type="button" class="lin-button is-primary" disabled={!text.trim() && !rule} onClick={apply}>Apply</button>
      </div>
    </div>
  );
};

export const FilterMenu = ({
  listId,
  tree,
  target,
  start,
  onChange,
  onClose,
  onAdvanced,
}: {
  listId: ListId;
  tree: LinearFilterGroup;
  target: Target;
  start: Stage;
  onChange: (tree: LinearFilterGroup) => void;
  onClose: () => void;
  onAdvanced?: () => void;
}) => {
  const [stage, setStage] = useState<Stage>(start);
  const [term, setTerm] = useState('');
  // The rule this menu edits, once there is one.
  const [path, setPath] = useState<FilterPath | null>(target.kind === 'rule' ? target.path : null);
  const { choices, fields, load, loading, partial } = useChoices(listId, target.kind !== 'bar');
  useEffect(() => void load(), []);

  /** Where a value of `field` goes: the rule this menu edits; in the bar, that property's top-level rule. */
  const locate = (field: LinearFilterField): FilterPath | null => {
    const own = ruleAt(tree, path);
    if (own && own.field === field) return path;
    if (target.kind === 'bar') {
      const index = tree.items.findIndex((node) => isFilterRule(node) && node.field === field);
      return index >= 0 ? [index] : null;
    }
    return null;
  };
  /** Change the rule of `field`, making it where there is none; a rule left without values goes. */
  const edit = (field: LinearFilterField, change: (rule: LinearFilterRule | null) => LinearFilterRule | null): void => {
    const at = locate(field);
    const next = change(ruleAt(tree, at));
    if (at) {
      // A chip whose rule goes closes its menu with it.
      if (!next && target.kind === 'rule') onClose();
      setPath(next ? at : null);
      onChange(replaceIn(tree, at, next));
      return;
    }
    if (!next) return;
    const grouped = target.kind === 'new' && target.group;
    const made = appendIn(tree, target.kind === 'new' ? target.parent : [], grouped ? { join: 'and', items: [next] } : next);
    setPath(grouped ? [...made.path, 0] : made.path);
    onChange(made.group);
  };

  if (stage.kind === 'fields') {
    // Typing a value's name offers it directly, as Linear's quick filters do.
    const quick: PickerOption[] = term.trim()
      ? fields
          .filter((field) => !isDateField(field) && field !== 'content')
          .flatMap((field) =>
            searchChoices(choices(field), term)
              .slice(0, 8)
              .map((option) => ({ value: `${field}|${option.value}`, label: option.label, hint: option.hint, icon: optionIcon(option), group: FILTER_FIELD_LABELS[field] })),
          )
          .slice(0, 40)
      : [];
    const used = (field: LinearFilterField) => target.kind === 'bar' && tree.items.some((node) => isFilterRule(node) && node.field === field);
    const fieldOptions: PickerOption[] = searchChoices(
      fields.map((field) => ({ value: field, label: FILTER_FIELD_LABELS[field], icon: <span class="lin-field-icon">{FIELD_ICONS[field]}</span>, hint: used(field) ? 'in use' : undefined })),
      term,
    ).map((option) => ({ ...option, group: term.trim() ? 'Filter by' : undefined }));
    const advanced: PickerOption[] = onAdvanced ? [{ value: '@advanced', label: 'Advanced filter…', hint: 'and / or, groups', icon: <span class="lin-field-icon">⊞</span>, sticky: true }] : [];
    return (
      <Picker
        key="fields"
        class="lin-filter-menu"
        label="Filter"
        placeholder="Filter…"
        options={[...fieldOptions, ...quick, ...advanced]}
        onSearch={setTerm}
        empty={loading ? 'Loading…' : 'No matches'}
        onClose={onClose}
        onPick={(option) => {
          if (option.value === '@advanced') {
            onAdvanced?.();
            return;
          }
          const [field, value] = option.value.split('|') as [LinearFilterField, string | undefined];
          if (value === undefined) {
            setStage(field === 'content' ? { kind: 'text', from: 'menu' } : { kind: 'values', field, from: 'menu' });
            return;
          }
          const found = choices(field).find((item) => item.value === value);
          if (found) edit(field, (rule) => (rule ? toggleRuleValue(rule, found) : freshRule(field, found)));
          onClose();
        }}
      />
    );
  }

  const current = ruleAt(tree, path);

  if (stage.kind === 'op') {
    if (!current) return null;
    const count = current.values.length || 1;
    return (
      <Picker
        key="op"
        class="lin-filter-menu is-small"
        label={`${FILTER_FIELD_LABELS[current.field]} filter operator`}
        placeholder="Change operator…"
        options={operatorsFor(current.field).map((op) => ({ value: op, label: operatorLabel(op, count) }))}
        selected={[current.op]}
        onClose={onClose}
        onPick={(option) => {
          const op = option.value as FilterOp;
          // Before or after needs a date where there was a choice; at least / at most needs one number.
          if (current.field === 'due' && (op === 'before' || op === 'after') && current.op === 'is') {
            setStage({ kind: 'date', field: 'due', op, from: 'chip' });
            return;
          }
          if (current.field === 'estimate' && isSingleValued(op) && !current.values.some((item) => item.value !== '')) {
            edit(current.field, (rule) => rule && { ...rule, op, values: [] });
            setStage({ kind: 'values', field: 'estimate', from: 'chip' });
            return;
          }
          edit(current.field, (rule) => {
            if (!rule) return null;
            const next = withOperator(rule, op);
            return next.values.length ? next : null;
          });
          onClose();
        }}
      />
    );
  }

  if (stage.kind === 'date') {
    const field = stage.field;
    return <DateForm field={field} op={stage.op} rule={ruleAt(tree, locate(field))} onClose={onClose} onApply={(date) => edit(field, () => ({ field, op: stage.op, values: [{ value: date, label: monthDay(date) }] }))} />;
  }

  if (stage.kind === 'text') {
    return <TextForm rule={ruleAt(tree, locate('content'))} onClose={onClose} onApply={(text) => edit('content', (rule) => (text ? { field: 'content', op: rule?.op ?? 'contains', values: [{ value: text, label: text }] } : null))} />;
  }

  const field = stage.field;
  const rule = ruleAt(tree, locate(field));
  const options = choices(field);
  const dated = rule && rule.values.some((item) => DATED.test(item.value));
  // A value chosen earlier that the workspace no longer offers still shows, so it can be unticked.
  const missing = (rule?.values ?? []).filter((item) => !options.some((option) => option.value === item.value) && !DATED.test(item.value));
  const listed: FilterOption[] = [...options, ...missing.map((item): FilterOption => ({ value: item.value, label: item.label, ...(item.color ? { color: item.color } : {}) }))];
  const all: PickerOption[] = listed.map((option) => ({ value: option.value, label: option.label, hint: option.hint, icon: optionIcon(option) }));
  if (field === 'due') all.push({ value: '@before', label: 'Before a date…', sticky: true }, { value: '@after', label: 'After a date…', sticky: true });
  if (isPointField(field)) all.push({ value: '@date', label: 'A date…', hint: rule?.op ?? 'after', sticky: true });
  // One value at a time: a created, updated or completed date, or an estimate of at least / at most.
  const single = isPointField(field) || Boolean(rule && isSingleValued(rule.op));
  return (
    <Picker
      key={`values:${field}`}
      class="lin-filter-menu"
      label={`Filter by ${FILTER_FIELD_LABELS[field]}`}
      placeholder={`${FILTER_FIELD_LABELS[field]}…`}
      options={all}
      multi={!single}
      selected={rule && !(field === 'due' && dated) ? rule.values.map((item) => item.value) : []}
      empty={loading ? 'Loading…' : 'No matches'}
      onBack={stage.from === 'menu' ? () => setStage({ kind: 'fields' }) : undefined}
      onClose={onClose}
      footer={
        <span class="lin-popover-help">
          {partial(field) && <span class="lin-filter-partial" role="note">{partial(field)}</span>}
          {stage.from === 'menu' && <button type="button" class="link" onClick={() => setStage({ kind: 'fields' })}>← Filters</button>}
          <span class="grow" />
          <span class="muted">{single ? '↑↓ move · Enter pick · Esc close' : '↑↓ move · Enter tick · Esc close'}</span>
        </span>
      }
      onPick={(option) => {
        if (option.value === '@before' || option.value === '@after') {
          setStage({ kind: 'date', field: 'due', op: option.value === '@before' ? 'before' : 'after', from: stage.from });
          return;
        }
        if (option.value === '@date' && isDateField(field)) {
          setStage({ kind: 'date', field, op: rule?.op === 'before' ? 'before' : 'after', from: stage.from });
          return;
        }
        const found = options.find((item) => item.value === option.value) ?? missing.find((item) => item.value === option.value);
        if (!found) return;
        if (single) {
          edit(field, (existing) => ({ field, op: existing?.op ?? defaultOperator(field), values: [{ value: found.value, label: found.label }] }));
          onClose();
          return;
        }
        // A date rule turns back into a choice of relative dates when one is ticked.
        if (field === 'due' && dated) {
          edit(field, () => freshRule(field, found));
          return;
        }
        edit(field, (existing) => (existing ? toggleRuleValue(existing, found) : freshRule(field, found)));
      }}
    />
  );
};

/** Where a chip's values open: the date of a before / after, the text of a content filter, else the values. */
export const valuesStage = (rule: LinearFilterRule): Stage => {
  if (rule.field === 'content') return { kind: 'text', from: 'chip' };
  if (isDateField(rule.field) && (rule.op === 'before' || rule.op === 'after') && DATED.test(rule.values[0]?.value ?? '')) return { kind: 'date', field: rule.field, op: rule.op, from: 'chip' };
  return { kind: 'values', field: rule.field, from: 'chip' };
};
