// Linear's filters for a list: a Filter button (and F) opens a menu of
// properties, then of values with ticks; typing finds values of any property
// at once. Each rule is a chip, "Status | is either of | Todo, In Progress",
// whose operator and values can be changed; with several, "Match all / any"
// says whether all or any must hold. "Advanced filter" (in the menu) opens
// Linear's builder: rows joined by and / or, and groups of rows, nested, each
// with its own and / or; a group shows in the bar as "Any of 2 filters" and
// opens in the builder. The choices come from the workspaces (every state,
// person, label, project, milestone and cycle), and the filters go to Linear,
// which answers with every matching issue.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { monthDay } from '../../../src/domain/dates.ts';
import {
  FILTER_FIELD_LABELS,
  LINEAR_FILTER_FIELDS,
  appendIn,
  defaultOperator,
  describeNode,
  describeRule,
  filterChoices,
  groupTitle,
  isFilterGroup,
  isFilterRule,
  isRawFilter,
  isSingleValued,
  joinIn,
  nodeIn,
  operatorLabel,
  operatorsFor,
  replaceIn,
  searchChoices,
  toggleRuleValue,
  valuesLabel,
  withOperator,
  type FilterJoin,
  type FilterOp,
  type FilterOption,
  type FilterPath,
  type FilterValue,
  type LinearFilterField,
  type LinearFilterGroup,
  type LinearFilterNode,
  type LinearFilterRule,
  type LinearRawFilter,
} from '../../../src/domain/linearFilter.ts';
import { useLinear, usePlanner } from '../../lib/context.ts';
import type { ListId } from '../../lib/linear.ts';
import { Avatar, CycleIcon, Dot, PriorityIcon, ProjectIcon, StatusIcon } from './icons.tsx';
import { Picker, useDismiss, useKeepInView, type PickerOption } from './Picker.tsx';

const FIELD_ICONS: Record<LinearFilterField, string> = {
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
export const optionIcon = (option: FilterOption) => {
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

const valuesText = (rule: LinearFilterRule): string => {
  if (rule.values.length <= 3) return valuesLabel(rule);
  return `${valuesLabel({ ...rule, values: rule.values.slice(0, 2) })} +${rule.values.length - 2}`;
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
  const names = new Map(lv.workspaces.map((workspace) => [workspace.id, workspace.name]));
  const loading = workspaceIds.some((id) => !lv.catalogs[id]);
  return {
    loading,
    load: () => linear.loadCatalogs(workspaceIds),
    choices: (field: LinearFilterField): FilterOption[] => filterChoices(field, catalogs, { teamIds, workspaceNames: names }),
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

const FilterMenu = ({
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
  const { choices, fields, load, loading } = useChoices(listId, target.kind !== 'bar');
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
const valuesStage = (rule: LinearFilterRule): Stage => {
  if (rule.field === 'content') return { kind: 'text', from: 'chip' };
  if (isDateField(rule.field) && (rule.op === 'before' || rule.op === 'after') && DATED.test(rule.values[0]?.value ?? '')) return { kind: 'date', field: rule.field, op: rule.op, from: 'chip' };
  return { kind: 'values', field: rule.field, from: 'chip' };
};

const keyOf = (node: LinearFilterNode, index: number): string => `${index}:${isFilterRule(node) ? node.field : isFilterGroup(node) ? 'group' : 'raw'}`;

interface TreeProps {
  listId: ListId;
  tree: LinearFilterGroup;
  onChange: (tree: LinearFilterGroup) => void;
}

/** A rule's chip: its property, its operator (a menu), its values (a menu) and ×. */
const RuleChip = ({ listId, tree, path, rule, onChange }: TreeProps & { path: FilterPath; rule: LinearFilterRule }) => {
  const [menu, setMenu] = useState<'op' | 'values' | null>(null);
  const close = useMemo(() => () => setMenu(null), []);
  const text = describeRule(rule);
  const op = operatorLabel(rule.op, rule.values.length);
  const name = FILTER_FIELD_LABELS[rule.field];
  return (
    <span class="lin-chip" role="group" aria-label={text} title={text}>
      <span class="lin-chip-field">
        <span class="lin-field-icon" aria-hidden="true">{FIELD_ICONS[rule.field]}</span>
        {name}
      </span>
      <span class="lin-anchor">
        <button type="button" class="lin-chip-op" aria-haspopup="listbox" aria-expanded={menu === 'op'} aria-label={`Operator of ${name}: ${op}`} onClick={() => setMenu(menu === 'op' ? null : 'op')}>
          {op}
        </button>
        {menu === 'op' && <FilterMenu listId={listId} tree={tree} target={{ kind: 'rule', path }} start={{ kind: 'op' }} onChange={onChange} onClose={close} />}
      </span>
      <span class="lin-anchor">
        <button type="button" class="lin-chip-values" aria-haspopup="listbox" aria-expanded={menu === 'values'} aria-label={`Edit filter: ${text}`} onClick={() => setMenu(menu === 'values' ? null : 'values')}>
          {valuesText(rule)}
        </button>
        {menu === 'values' && <FilterMenu listId={listId} tree={tree} target={{ kind: 'rule', path }} start={valuesStage(rule)} onChange={onChange} onClose={close} />}
      </span>
      <button type="button" class="lin-chip-remove" aria-label={`Remove filter: ${text}`} onClick={() => onChange(replaceIn(tree, path, null))}>×</button>
    </span>
  );
};

/** A part of a saved view's filter the Planner keeps as it is: shown in words, removable. */
const RawChip = ({ tree, path, node, onChange }: Omit<TreeProps, 'listId'> & { path: FilterPath; node: LinearRawFilter }) => (
  <span class="lin-chip is-raw" role="group" aria-label={node.label} title={`${node.label}: saved with the view, applied as Linear keeps it`}>
    <span class="lin-chip-field">
      <span class="lin-field-icon" aria-hidden="true">≋</span>
      {node.label}
    </span>
    <button type="button" class="lin-chip-remove" aria-label={`Remove filter: ${node.label}`} onClick={() => onChange(replaceIn(tree, path, null))}>×</button>
  </span>
);

/** A group in the bar, as Linear shows one: "Any of 2 filters", opened in the builder. */
const GroupChip = ({ listId, tree, path, group, onChange }: TreeProps & { path: FilterPath; group: LinearFilterGroup }) => {
  const [open, setOpen] = useState(false);
  const close = useMemo(() => () => setOpen(false), []);
  const title = groupTitle(group);
  const text = describeNode(group);
  return (
    <span class="lin-chip is-group" role="group" aria-label={text} title={text}>
      <span class="lin-anchor">
        <button type="button" class="lin-chip-values" aria-haspopup="dialog" aria-expanded={open} aria-label={`Edit filter group: ${title}`} onClick={() => setOpen(!open)}>
          <span class="lin-field-icon" aria-hidden="true">⊞</span> {title}
        </button>
        {open && <AdvancedFilter listId={listId} tree={tree} path={path} onChange={onChange} onClose={close} />}
      </span>
      <button type="button" class="lin-chip-remove" aria-label={`Remove filter: ${title}`} onClick={() => onChange(replaceIn(tree, path, null))}>×</button>
    </span>
  );
};

/** Groups go two levels below the top, as far as a readable builder goes. */
const MAX_GROUP_DEPTH = 2;

/** "+ Add filter" and "+ Add group" at the end of a group. */
const AddButtons = ({ listId, tree, parent, canGroup, onChange }: TreeProps & { parent: FilterPath; canGroup: boolean }) => {
  const [adding, setAdding] = useState<'rule' | 'group' | null>(null);
  const close = useMemo(() => () => setAdding(null), []);
  return (
    <span class="lin-adv-add">
      <span class="lin-anchor">
        <button type="button" class="lin-button lin-adv-add-button" aria-haspopup="dialog" aria-expanded={adding === 'rule'} aria-label="Add filter" onClick={() => setAdding(adding === 'rule' ? null : 'rule')}>
          + Add filter
        </button>
        {adding === 'rule' && <FilterMenu listId={listId} tree={tree} target={{ kind: 'new', parent, group: false }} start={{ kind: 'fields' }} onChange={onChange} onClose={close} />}
      </span>
      {canGroup && (
        <span class="lin-anchor">
          <button type="button" class="lin-button lin-adv-add-button" aria-haspopup="dialog" aria-expanded={adding === 'group'} aria-label="Add filter group" onClick={() => setAdding(adding === 'group' ? null : 'group')}>
            + Add group
          </button>
          {adding === 'group' && <FilterMenu listId={listId} tree={tree} target={{ kind: 'new', parent, group: true }} start={{ kind: 'fields' }} onChange={onChange} onClose={close} />}
        </span>
      )}
    </span>
  );
};

/**
 * A group's rows, as Linear's builder lays them out: the first filter, then
 * each next one after "and" or "or" (the first of those switches the group
 * between all and any), groups as boxes of their own, and "+ Add filter".
 */
const GroupRows = ({ listId, tree, path, depth, onChange }: TreeProps & { path: FilterPath; depth: number }) => {
  const group = nodeIn(tree, path);
  if (!group || !isFilterGroup(group)) return null;
  const other: FilterJoin = group.join === 'and' ? 'or' : 'and';
  const connector = (row: number) => {
    if (row === 0) return null;
    if (row > 1) return <span class="lin-adv-word">{group.join}</span>;
    return (
      <button
        type="button"
        class="lin-adv-switch"
        aria-label={`${group.join === 'or' ? 'Any' : 'All'} of these filters: switch to ${other === 'or' ? 'any' : 'all'}`}
        title={`Match ${other === 'or' ? 'any' : 'all'} of these filters instead`}
        onClick={() => onChange(joinIn(tree, path, other))}
      >
        {group.join}
      </button>
    );
  };
  return (
    <div class="lin-adv-rows">
      {group.items.map((node, index) => {
        const at = [...path, index];
        return (
          <div class="lin-adv-row" key={keyOf(node, index)}>
            <span class="lin-adv-join">{connector(index)}</span>
            {isFilterRule(node) ? (
              <RuleChip listId={listId} tree={tree} path={at} rule={node} onChange={onChange} />
            ) : isRawFilter(node) ? (
              <RawChip tree={tree} path={at} node={node} onChange={onChange} />
            ) : (
              <div class="lin-adv-group" role="group" aria-label={describeNode(node)}>
                <GroupRows listId={listId} tree={tree} path={at} depth={depth + 1} onChange={onChange} />
                <button type="button" class="lin-adv-remove" aria-label={`Remove filter group: ${groupTitle(node)}`} title="Remove this group" onClick={() => onChange(replaceIn(tree, at, null))}>×</button>
              </div>
            )}
          </div>
        );
      })}
      <div class="lin-adv-row" key="add">
        <span class="lin-adv-join">{connector(group.items.length)}</span>
        <AddButtons listId={listId} tree={tree} parent={path} canGroup={depth < MAX_GROUP_DEPTH} onChange={onChange} />
      </div>
    </div>
  );
};

/** Linear's advanced filter: the whole filter (path []) or one group of it, as rows and nested groups. */
const AdvancedFilter = ({ listId, tree, path, onChange, onClose }: TreeProps & { path: FilterPath; onClose: () => void }) => {
  const root = useRef<HTMLDivElement>(null);
  useDismiss(root, onClose);
  useKeepInView(root);
  const group = nodeIn(tree, path);
  const gone = !group || !isFilterGroup(group);
  // A group removed meanwhile (its last filter went) closes its builder.
  useEffect(() => {
    if (gone) onClose();
  }, [gone]);
  if (gone) return null;
  return (
    <div class="lin-popover lin-advanced" role="dialog" aria-label={path.length ? 'Filter group' : 'Advanced filter'} ref={root} onKeyDown={(event) => event.stopPropagation()}>
      <div class="lin-popover-title">{path.length ? groupTitle(group) : 'Advanced filter'}</div>
      <div class="lin-advanced-body">
        <GroupRows listId={listId} tree={tree} path={path} depth={path.length} onChange={onChange} />
      </div>
      <div class="lin-popover-footer">
        <span class="lin-popover-help">
          <span class="muted">“and” / “or” switches a group between all and any · Esc closes</span>
        </span>
      </div>
    </div>
  );
};

/** Whether all or any of the top-level filters must hold. */
const MatchSwitch = ({ match, onChange }: { match: FilterJoin; onChange: (match: FilterJoin) => void }) => {
  const [open, setOpen] = useState(false);
  const close = useMemo(() => () => setOpen(false), []);
  return (
    <span class="lin-anchor">
      <button type="button" class="lin-button lin-match" aria-haspopup="listbox" aria-expanded={open} aria-label={match === 'or' ? 'Match any filter' : 'Match all filters'} title="Whether all or any of these filters must hold" onClick={() => setOpen(!open)}>
        Match {match === 'or' ? 'any' : 'all'} <span class="lin-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <Picker
          class="lin-filter-menu is-small"
          label="Match"
          placeholder="Match…"
          options={[{ value: 'and', label: 'All filters' }, { value: 'or', label: 'Any filter' }]}
          selected={[match]}
          onClose={close}
          onPick={(option) => {
            onChange(option.value as FilterJoin);
            setOpen(false);
          }}
        />
      )}
    </span>
  );
};

/** Filters of a list: the match switch, chips, the Filter button and its menu, Clear (and Reset for a changed view). `open` lets F open the menu. */
export const FilterBar = ({ listId, open, onOpenChange, compact = false }: { listId: ListId; open: boolean; onOpenChange: (open: boolean) => void; compact?: boolean }) => {
  const { linear } = usePlanner();
  const lv = useLinear();
  const list = lv.lists[listId];
  const tree: LinearFilterGroup = { join: list.match, items: list.filters };
  const [advanced, setAdvanced] = useState(false);
  const change = (next: LinearFilterGroup) => linear.setFilters(next.items, listId, next.join);
  const closeMenu = useMemo(() => () => onOpenChange(false), [onOpenChange]);
  const closeAdvanced = useMemo(() => () => setAdvanced(false), []);
  // A view with filters of its own, changed here: Reset brings them back (for one without, Clear does).
  const changed = Boolean(list.viewFilters?.length) && (list.match !== 'and' || JSON.stringify(list.viewFilters) !== JSON.stringify(list.filters));
  return (
    <div class={`lin-filters${compact ? ' is-compact' : ''}`} role="group" aria-label="Filters">
      {list.filters.length > 1 && <MatchSwitch key="match" match={list.match} onChange={(join) => change({ ...tree, join })} />}
      {list.filters.map((node, index) =>
        isFilterRule(node) ? (
          <RuleChip key={keyOf(node, index)} listId={listId} tree={tree} path={[index]} rule={node} onChange={change} />
        ) : isFilterGroup(node) ? (
          <GroupChip key={keyOf(node, index)} listId={listId} tree={tree} path={[index]} group={node} onChange={change} />
        ) : (
          <RawChip key={keyOf(node, index)} tree={tree} path={[index]} node={node} onChange={change} />
        ),
      )}
      <span class="lin-anchor" key="filter">
        <button
          type="button"
          class="lin-button lin-filter-button"
          aria-haspopup="dialog"
          aria-expanded={open}
          title="Filter (F)"
          onClick={() => {
            setAdvanced(false);
            onOpenChange(!open);
          }}
        >
          <span aria-hidden="true">⚲</span> Filter
        </button>
        {open && (
          <FilterMenu
            listId={listId}
            tree={tree}
            target={{ kind: 'bar' }}
            start={{ kind: 'fields' }}
            onChange={change}
            onClose={closeMenu}
            onAdvanced={() => {
              onOpenChange(false);
              setAdvanced(true);
            }}
          />
        )}
        {advanced && <AdvancedFilter listId={listId} tree={tree} path={[]} onChange={change} onClose={closeAdvanced} />}
      </span>
      {list.filters.length > 0 && <button key="clear" type="button" class="link lin-clear" aria-label="Clear filters" onClick={() => change({ join: 'and', items: [] })}>Clear</button>}
      {changed && <button key="reset" type="button" class="link lin-clear" aria-label="Reset the view's filters" title="The view's filters as saved in Linear" onClick={() => linear.resetFilters(listId)}>Reset</button>}
    </div>
  );
};
