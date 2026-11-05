// Linear's filters for a list: a Filter button (and F) opens the Filter menu
// (FilterMenu.tsx). Each rule is a chip, "Status | is either of | Todo, In
// Progress", whose operator and values can be changed; with several, "Match
// all / any" says whether all or any must hold. "Advanced filter" (in the menu)
// opens Linear's builder: rows joined by and / or, and groups of rows, nested,
// each with its own and / or; a group shows in the bar as "Any of 2 filters"
// and opens in the builder. The filters go to Linear, which answers with every
// matching issue.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  FILTER_FIELD_LABELS,
  describeNode,
  describeRule,
  groupTitle,
  isFilterGroup,
  isFilterRule,
  isRawFilter,
  joinIn,
  nodeIn,
  operatorLabel,
  replaceIn,
  valuesLabel,
  type FilterJoin,
  type FilterPath,
  type LinearFilterGroup,
  type LinearFilterNode,
  type LinearFilterRule,
  type LinearRawFilter,
} from '../../../src/domain/linear/filter.ts';
import { useLinear, usePlanner } from '../../lib/core/context.ts';
import type { ListId } from '../../lib/linear/types.ts';
import { FIELD_ICONS, FilterMenu, valuesStage } from './FilterMenu.tsx';
import { Picker, useDismiss, useKeepInView } from './Picker.tsx';

const valuesText = (rule: LinearFilterRule): string => {
  if (rule.values.length <= 3) return valuesLabel(rule);
  return `${valuesLabel({ ...rule, values: rule.values.slice(0, 2) })} +${rule.values.length - 2}`;
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

/** Filters of a list: the match switch, chips, the Filter button and its menu, Clear (and Reset and Save for a changed view). `open` lets F open the menu. */
export const FilterBar = ({ listId, open, onOpenChange, compact = false }: { listId: ListId; open: boolean; onOpenChange: (open: boolean) => void; compact?: boolean }) => {
  const { linear, client } = usePlanner();
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
      {changed && (
        <button
          key="save"
          type="button"
          class="link lin-clear"
          aria-label="Save the filters to the view"
          title={linear.canSaveFilters(listId) ? 'Save these filters to the view in Linear, as its Save does' : 'A due date of today or this week would be saved as fixed dates; change it to save the view'}
          disabled={!linear.canSaveFilters(listId)}
          onClick={() => void linear.saveFilters(listId).catch((error) => client.notify(`Linear did not save the view: ${error instanceof Error ? error.message : String(error)}`))}
        >
          Save
        </button>
      )}
    </div>
  );
};
