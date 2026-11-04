// Linear's Display options: layout, grouping and sub-grouping, ordering and
// its direction, completed issues, sub-issues, empty groups, triage, and the
// properties rows show. An open saved view changes only while it is open (as
// in Linear until the view is saved); the Planner's own lists keep the choice.
import { useMemo, useRef, useState } from 'preact/hooks';
import { LINEAR_COMPLETED, LINEAR_GROUPS, LINEAR_ORDERS, LINEAR_PROPERTIES, type LinearCompletedWindow, type LinearGroupBy, type LinearOrderBy } from '../../../src/domain/types.ts';
import { COMPLETED_LABELS, GROUP_LABELS, ORDER_LABELS, PROPERTY_LABELS, type IssueDisplay, type ProjectGroupBy, type ProjectOrderBy } from '../../../src/domain/linearDisplay.ts';
import { useLinear, usePlanner, useView } from '../../lib/context.ts';
import { displayOf, type ListId } from '../../lib/linear.ts';
import { Picker, PickerButton, useDismiss } from './Picker.tsx';

const Switch = ({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) => (
  <button type="button" class="lin-toggle" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}>
    <span class="lin-toggle-label">{label}</span>
    <span class={`lin-switch${checked ? ' is-on' : ''}`} aria-hidden="true"><span /></span>
  </button>
);

const PROJECT_GROUP_LABELS: Record<ProjectGroupBy, string> = { status: 'Status', lead: 'Lead', health: 'Health', priority: 'Priority', none: 'No grouping' };
const PROJECT_ORDER_LABELS: Record<ProjectOrderBy, string> = { manual: 'Manual', priority: 'Priority', status: 'Status', updated: 'Last updated', created: 'Last created', target: 'Target date', start: 'Start date', name: 'Name' };

type Open = 'group' | 'sub' | 'order' | 'completed' | null;

/** A row of the menu: its name, then a picker of choices. */
const Choice = <T extends string>({ name, value, labels, choices, open, setOpen, id, onPick }: { name: string; value: T; labels: Record<T, string>; choices: readonly T[]; open: Open; setOpen: (open: Open) => void; id: Exclude<Open, null>; onPick: (value: T) => void }) => {
  const close = useMemo(() => () => setOpen(null), [setOpen]);
  return (
    <div class="lin-display-row">
      <span class="lin-display-name">{name}</span>
      <PickerButton label={name} value={labels[value]} open={open === id} onOpen={() => setOpen(open === id ? null : id)}>
        <Picker
          label={name}
          placeholder={`${name}…`}
          options={choices.map((choice) => ({ value: choice, label: labels[choice] }))}
          selected={[value]}
          onClose={close}
          onPick={(option) => {
            onPick(option.value as T);
            setOpen(null);
          }}
        />
      </PickerButton>
    </div>
  );
};

/** The Display menu of an issue list. */
export const DisplayMenu = ({ listId, onClose }: { listId: ListId; onClose: () => void }) => {
  const { linear } = usePlanner();
  const lv = useLinear();
  const view = useView();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<Open>(null);
  useDismiss(root, onClose);
  const list = lv.lists[listId];
  const display = displayOf(list, view.state.settings, listId);
  const set = (patch: Partial<IssueDisplay>) => void linear.setDisplay(patch, listId);
  const groups = LINEAR_GROUPS.filter((group) => group !== 'workspace' || lv.workspaces.length > 1 || display.groupBy === 'workspace');
  const subGroups = groups.filter((group) => group === 'none' || group !== display.groupBy);
  const ordering: LinearOrderBy[] = [...LINEAR_ORDERS];
  return (
    <div class="lin-popover lin-display" role="dialog" aria-label="Display options" ref={root}>
      <div class="lin-display-row">
        <span class="lin-display-name">Layout</span>
        <div class="lin-segmented" role="radiogroup" aria-label="Layout">
          {(['list', 'board'] as const).map((layout) => (
            <button key={layout} type="button" role="radio" aria-checked={display.layout === layout} onClick={() => set({ layout })}>
              <span aria-hidden="true">{layout === 'list' ? '☰' : '▥'}</span> {layout === 'list' ? 'List' : 'Board'}
            </button>
          ))}
        </div>
      </div>
      <Choice<LinearGroupBy> name="Grouping" id="group" value={display.groupBy} labels={GROUP_LABELS} choices={groups} open={open} setOpen={setOpen} onPick={(groupBy) => set({ groupBy, ...(display.subGroupBy === groupBy ? { subGroupBy: 'none' } : {}) })} />
      <Choice<LinearGroupBy> name="Sub-grouping" id="sub" value={display.subGroupBy} labels={GROUP_LABELS} choices={subGroups} open={open} setOpen={setOpen} onPick={(subGroupBy) => set({ subGroupBy })} />
      <div class="lin-display-row">
        <span class="lin-display-name">Ordering</span>
        <span class="lin-display-pair">
          <PickerButton label="Ordering" value={ORDER_LABELS[display.orderBy]} open={open === 'order'} onOpen={() => setOpen(open === 'order' ? null : 'order')}>
            <Picker
              label="Ordering"
              placeholder="Ordering…"
              options={ordering.map((order) => ({ value: order, label: ORDER_LABELS[order] }))}
              selected={[display.orderBy]}
              onClose={() => setOpen(null)}
              onPick={(option) => {
                set({ orderBy: option.value as LinearOrderBy });
                setOpen(null);
              }}
            />
          </PickerButton>
          <button
            type="button"
            class="lin-icon-button"
            aria-label="Reverse the order"
            aria-pressed={display.orderReverse}
            disabled={display.orderBy === 'manual'}
            title={display.orderReverse ? 'Reversed' : 'Natural order'}
            onClick={() => set({ orderReverse: !display.orderReverse })}
          >
            {display.orderReverse ? '↑' : '↓'}
          </button>
        </span>
      </div>
      <Choice<LinearCompletedWindow> name="Completed issues" id="completed" value={display.showCompleted} labels={COMPLETED_LABELS} choices={LINEAR_COMPLETED} open={open} setOpen={setOpen} onPick={(showCompleted) => set({ showCompleted })} />
      <hr />
      <Switch label="Show sub-issues" checked={display.showSubIssues} onChange={(showSubIssues) => set({ showSubIssues })} />
      {display.layout === 'board' ? (
        <Switch label="Show empty columns" checked={display.showEmptyColumns} onChange={(showEmptyColumns) => set({ showEmptyColumns })} />
      ) : (
        <Switch label="Show empty groups" checked={display.showEmptyGroups} onChange={(showEmptyGroups) => set({ showEmptyGroups })} />
      )}
      <Switch label="Show triage issues" checked={display.showTriage} onChange={(showTriage) => set({ showTriage })} />
      <hr />
      <div class="lin-display-name">Display properties</div>
      <div class="lin-properties" role="group" aria-label="Display properties">
        {LINEAR_PROPERTIES.map((property) => {
          const on = display.properties.includes(property);
          return (
            <button key={property} type="button" class={`lin-property${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => set({ properties: on ? display.properties.filter((item) => item !== property) : LINEAR_PROPERTIES.filter((item) => item === property || display.properties.includes(item)) })}>
              {PROPERTY_LABELS[property]}
            </button>
          );
        })}
      </div>
      {list.display && (
        <p class="lin-display-note">
          {list.view?.name ? `As saved with “${list.view.name}” in Linear. ` : ''}Changes here last while the view is open.
          {list.unsupported.length > 0 && ` Linear also has ${list.unsupported.join(', ')}, which the Planner shows its own way.`}
        </p>
      )}
    </div>
  );
};

/** The Display menu of a saved view of projects. */
export const ProjectDisplayMenu = ({ listId, onClose }: { listId: ListId; onClose: () => void }) => {
  const { linear } = usePlanner();
  const lv = useLinear();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<Open>(null);
  useDismiss(root, onClose);
  const list = lv.lists[listId];
  const display = list.projectDisplay;
  if (!display) return null;
  return (
    <div class="lin-popover lin-display" role="dialog" aria-label="Display options" ref={root}>
      <Choice<ProjectGroupBy> name="Grouping" id="group" value={display.groupBy} labels={PROJECT_GROUP_LABELS} choices={['status', 'lead', 'health', 'priority', 'none']} open={open} setOpen={setOpen} onPick={(groupBy) => linear.setProjectDisplay({ groupBy }, listId)} />
      <Choice<ProjectOrderBy> name="Ordering" id="order" value={display.orderBy} labels={PROJECT_ORDER_LABELS} choices={['manual', 'priority', 'status', 'updated', 'created', 'target', 'start', 'name']} open={open} setOpen={setOpen} onPick={(orderBy) => linear.setProjectDisplay({ orderBy }, listId)} />
      <Choice<LinearCompletedWindow> name="Completed projects" id="completed" value={display.showCompleted} labels={COMPLETED_LABELS} choices={LINEAR_COMPLETED} open={open} setOpen={setOpen} onPick={(showCompleted) => linear.setProjectDisplay({ showCompleted }, listId)} />
      <p class="lin-display-note">
        {list.view?.name ? `As saved with “${list.view.name}” in Linear. ` : ''}Changes here last while the view is open.
        {list.unsupported.length > 0 && ` Linear also has ${list.unsupported.join(', ')}, shown here as a list.`}
      </p>
    </div>
  );
};
