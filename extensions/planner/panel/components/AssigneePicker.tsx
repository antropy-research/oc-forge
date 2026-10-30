import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  assigneeOptions,
  avatarColor,
  initials,
  isAssigneeId,
  matchesQuery,
  modelLabel,
  newPresetId,
  presetAssignee,
  presetName,
  taskAssignees,
  type AssigneeOption,
} from '../../src/domain/assignees.ts';
import { newId } from '../../src/domain/ids.ts';
import type { AgentPreset, RunAssignee } from '../../src/domain/types.ts';
import { useAgents, usePlanner, useView } from '../lib/context.ts';
import { useFixedPlace } from '../lib/popover.ts';
import { useUi } from '../lib/ui.ts';

/** An assignee's round badge: its initials on its color. */
export const Avatar = ({ name, id, color, small = false }: { name: string; id: string; color?: string | null; small?: boolean }) => (
  <span class={`avatar${small ? ' is-small' : ''}`} style={{ '--avatar-color': avatarColor(id, color) }} aria-hidden="true">{initials(name)}</span>
);

/** The assignee as a run keeps it. */
export const toAssignee = (option: Pick<AssigneeOption, 'id' | 'name' | 'agent' | 'model'>): RunAssignee => ({ id: option.id, name: option.name, agent: option.agent, model: option.model });

/** A row of the picker: an assignee, OpenChamber's default (id null), or an agent with a model to save as a preset. */
type PickerOption = (AssigneeOption & { pick: 'assignee' }) | { pick: 'default'; id: null; name: string; detail: string } | { pick: 'model'; id: string; name: string; detail: string; agent: string; model: string };

const DEFAULT_ROW = { pick: 'default' as const, id: null, name: "OpenChamber's default", detail: 'The agent and model OpenChamber starts chats with' };

/** What a pick turns into: a preset is made for an agent picked with a model. */
export const usePickResult = () => {
  const { client } = usePlanner();
  return async (option: PickerOption): Promise<RunAssignee | null> => {
    if (option.pick === 'default') return null;
    if (option.pick === 'assignee') return toAssignee(option);
    const presets = client.getView().state.settings.agentPresets ?? [];
    const existing = presets.find((preset) => preset.agent === option.agent && preset.model === option.model);
    if (existing) return presetAssignee(existing);
    const preset: AgentPreset = { id: newPresetId(option.name, newId().slice(-4)), name: option.name, agent: option.agent, model: option.model };
    if (!isAssigneeId(preset.id)) return null;
    await client.dispatch([{ type: 'settings.updated', patch: { agentPresets: [...presets, preset] } }], { undo: `Saved the preset ${preset.name}` });
    return presetAssignee(preset);
  };
};

interface PickerProps {
  /** The task whose assignees are checked; null for an issue that is no task yet. */
  taskId: string | null;
  /** The project folder whose own agents to list too. */
  directory: string | null;
  onPick: (option: PickerOption) => void;
  onClose: () => void;
  /** "Choose" in a form: the chosen one is checked, and OpenChamber's default is a row. */
  chosen?: { id: string | null } | null;
  title?: string;
  align?: 'left' | 'right';
  footer?: ComponentChildren;
}

let pickerCount = 0;

/**
 * "Assign to…", as GitHub's and Linear's assignee menus: a search box, the
 * presets and agents in sections with their avatars, the current assignees
 * checked; arrows and Enter pick, Escape closes. Typing a model's name offers
 * an agent with that model, saved as a preset when picked.
 */
export const AssigneePicker = ({ taskId, directory, onPick, onClose, chosen, title = 'Assign to an agent', align = 'right', footer }: PickerProps) => {
  const { agents } = usePlanner();
  const view = useView();
  const av = useAgents();
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [uid] = useState(() => `assignee-${++pickerCount}`);

  useEffect(() => {
    void agents.loadCatalog(directory);
  }, [agents, directory]);
  useEffect(() => {
    // The button that opened it toggles it; a press anywhere else closes it.
    const close = (event: MouseEvent) => {
      const anchor = ref.current?.closest('.menu-anchor') ?? ref.current;
      if (!anchor?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [onClose]);

  const presets = view.state.settings.agentPresets ?? [];
  const catalog = av.catalog;
  const options = useMemo(() => assigneeOptions(presets, catalog?.agents ?? []), [presets, catalog]);
  const checked = new Set(chosen !== undefined ? [chosen?.id ?? null] : taskId ? taskAssignees(view.state, taskId).map((assignee) => assignee.id) : []);
  const trimmed = query.trim();
  const sections: { label: string; options: PickerOption[] }[] = [];
  const shown = options.filter((option) => !trimmed || matchesQuery(option, trimmed));
  const presetRows = shown.filter((option) => option.kind === 'preset').map((option) => ({ ...option, pick: 'assignee' as const }));
  const agentRows = shown.filter((option) => option.kind === 'agent').map((option) => ({ ...option, pick: 'assignee' as const }));
  if (chosen !== undefined && (!trimmed || matchesQuery({ name: DEFAULT_ROW.name, agent: '', model: null, detail: DEFAULT_ROW.detail }, trimmed))) sections.push({ label: 'Default', options: [DEFAULT_ROW] });
  if (presetRows.length) sections.push({ label: 'Presets', options: presetRows });
  if (agentRows.length) sections.push({ label: 'Agents', options: agentRows });
  // A model's name typed in: that agent (or the default one) on that model.
  if (trimmed.length >= 2 && catalog) {
    const words = trimmed.toLowerCase().split(/\s+/);
    const named = catalog.agents.filter((agent) => words.some((word) => agent.name.toLowerCase().startsWith(word) || agent.label.toLowerCase().startsWith(word)));
    const rest = words.filter((word) => !named.some((agent) => agent.name.toLowerCase().startsWith(word) || agent.label.toLowerCase().startsWith(word)));
    const base = named.length ? named : catalog.agents.filter((agent) => agent.name === (catalog.defaultAgent ?? 'build')).slice(0, 1);
    const models = rest.length ? catalog.models.filter((model) => rest.every((word) => `${model.id} ${model.name ?? ''}`.toLowerCase().includes(word))) : [];
    const combos = base.flatMap((agent) => models.map((model) => ({ agent, model }))).filter(({ agent, model }) => !presets.some((preset) => preset.agent === agent.name && preset.model === model.id)).slice(0, 8);
    if (combos.length) {
      sections.push({
        label: 'Models',
        options: combos.map(({ agent, model }) => ({ pick: 'model' as const, id: `model-${agent.name}-${model.id}`, name: presetName(agent.label, model.id), detail: `${agent.label} on ${model.name ?? modelLabel(model.id)}; saved as a preset`, agent: agent.name, model: model.id })),
      });
    }
  }
  const flat = sections.flatMap((section) => section.options);
  const index = Math.min(active, Math.max(0, flat.length - 1));
  const optionId = (at: number) => `${uid}-${at}`;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (flat.length) setActive((index + (event.key === 'ArrowDown' ? 1 : flat.length - 1)) % flat.length);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActive(event.key === 'Home' ? 0 : Math.max(0, flat.length - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = flat[index];
      if (option) onPick(option);
    } else if (event.key === 'Tab') onClose();
  };
  useEffect(() => {
    ref.current?.querySelector(`#${optionId(index)}`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  // Placed in the window, beside its button: a scrolling list it opens from does not cut it off.
  const placement = useFixedPlace(ref, align, `${flat.length}:${Boolean(catalog)}`);
  // The search box takes the focus once the picker is placed: hidden until then, it cannot be focused.
  const placed = placement.visibility !== 'hidden';
  useEffect(() => {
    if (placed) input.current?.focus({ preventScroll: true });
  }, [placed]);
  let at = -1;
  return (
    <div class={`assignee-menu${align === 'left' ? ' is-left' : ''}`} role="dialog" aria-label={title} ref={ref} style={placement} onKeyDown={(event) => event.key === 'Escape' && event.stopPropagation()}>
      <div class="assignee-head">
        <span class="assignee-title">{title}</span>
        <input
          ref={input}
          class="assignee-search"
          role="combobox"
          aria-label="Search agents"
          aria-expanded="true"
          aria-controls={`${uid}-list`}
          aria-autocomplete="list"
          aria-activedescendant={flat.length ? optionId(index) : undefined}
          placeholder="Assign to…"
          value={query}
          onInput={(event) => {
            setQuery(event.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div class="assignee-list" role="listbox" id={`${uid}-list`} aria-label="Agents" aria-multiselectable={chosen === undefined ? 'true' : undefined}>
        {sections.map((section) => (
          <div key={section.label} role="group" aria-label={section.label} class="assignee-group">
            <div class="assignee-section" aria-hidden="true">{section.label}</div>
            {section.options.map((option) => {
              at += 1;
              const position = at;
              const isChecked = checked.has(option.id);
              const color = option.pick === 'assignee' ? option.color : null;
              return (
                <div
                  key={option.id ?? 'default'}
                  id={optionId(position)}
                  role="option"
                  aria-selected={isChecked}
                  aria-label={option.name}
                  title={option.detail}
                  class={`assignee-option${position === index ? ' is-active' : ''}${option.pick === 'assignee' && option.missing ? ' is-missing' : ''}`}
                  onMouseMove={() => position !== index && setActive(position)}
                  onMouseDown={(event) => event.preventDefault()}
                  // The picker's clicks are its own: a row or card holding it must not act on them (picking can
                  // re-render the picker away before the click bubbles, so it is stopped here, where it starts).
                  onClick={(event) => {
                    event.stopPropagation();
                    onPick(option);
                  }}
                >
                  {option.pick === 'default' ? <span class="avatar is-default" aria-hidden="true">OC</span> : <Avatar name={option.name} id={option.pick === 'model' ? option.agent : option.id} color={color} />}
                  <span class="assignee-text">
                    <span class="assignee-name">{option.name}</span>
                    <span class="assignee-detail">{option.pick === 'assignee' && option.missing ? 'OpenCode has no such agent now' : option.detail}</span>
                  </span>
                  <svg class={`assignee-check${isChecked ? ' is-on' : ''}`} viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>
                </div>
              );
            })}
          </div>
        ))}
        {av.catalogLoading && !catalog && <p class="hint assignee-note">Finding OpenCode's agents…</p>}
        {!av.catalogLoading && flat.length === 0 && <p class="hint assignee-note">{trimmed ? `No agent or model matches "${trimmed}".` : 'No agents found.'}</p>}
        {av.catalogError && <p class="feed-errors assignee-note" role="alert">{av.catalogError}</p>}
        {catalog?.modelsError && trimmed.length >= 2 && <p class="hint assignee-note">{catalog.modelsError}</p>}
      </div>
      {footer && <div class="assignee-footer">{footer}</div>}
    </div>
  );
};

/**
 * A button that opens the picker; a pick assigns the task at once, as in
 * GitHub or Linear: a new worktree in the chosen project, then a pull request.
 * `prepare` makes the task first (an issue row plans it); it returns its id.
 */
export const AssignButton = ({
  taskId,
  prepare,
  label,
  className,
  align = 'right',
  children,
}: {
  taskId: string | null;
  prepare?: () => Promise<string | null>;
  label: string;
  className?: string;
  align?: 'left' | 'right';
  children: ComponentChildren;
}) => {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <span class="menu-anchor assign-anchor">
      <button
        ref={trigger}
        class={className}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
      >
        {children}
      </button>
      {open && (
        <AssignPopover
          taskId={taskId}
          prepare={prepare}
          align={align}
          onClose={() => {
            setOpen(false);
            // Back to the button that opened it, as a menu does, when the focus was in the picker.
            if (trigger.current?.parentElement?.contains(document.activeElement)) trigger.current.focus();
          }}
        />
      )}
    </span>
  );
};

/** The picker for assigning now, with the project to work in and the way to the full options. */
export const AssignPopover = ({ taskId, prepare, align, onClose }: { taskId: string | null; prepare?: () => Promise<string | null>; align?: 'left' | 'right'; onClose: () => void }) => {
  const { agents, client } = usePlanner();
  const av = useAgents();
  const view = useView();
  const { setUi } = useUi();
  const result = usePickResult();
  const [projectId, setProjectId] = useState(() => agents.defaultProject(view.state, taskId ?? '')?.id ?? '');
  useEffect(() => {
    if (!projectId && av.projects[0]) setProjectId(agents.defaultProject(view.state, taskId ?? '')?.id ?? av.projects[0].id);
  }, [av.projects.length]);
  const project = av.projects.find((item) => item.id === projectId) ?? null;
  const target = async (): Promise<string | null> => taskId ?? (prepare ? await prepare() : null);
  const pick = async (option: PickerOption) => {
    onClose();
    try {
      const assignee = await result(option);
      const id = await target();
      if (id) await agents.assign(id, assignee, projectId || null);
    } catch (error) {
      client.notify(`Could not assign it: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return (
    <AssigneePicker
      taskId={taskId}
      directory={project?.directory ?? null}
      align={align}
      onPick={(option) => void pick(option)}
      onClose={onClose}
      footer={
        <>
          {av.projects.length > 1 ? (
            <label class="assignee-project">
              In
              <select aria-label="Agent project" value={projectId} onChange={(event) => setProjectId(event.currentTarget.value)}>
                {av.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
          ) : (
            <span>{project ? `In ${project.name}` : av.available === false ? 'Projects are not shared with the Planner' : 'Add a project in OpenChamber first'}</span>
          )}
          <span class="muted">a new worktree, then a pull request</span>
          <button
            class="link"
            onClick={(event) => {
              event.stopPropagation();
              onClose();
              void target().then((id) => id && setUi({ openTaskId: id, agentForm: 'assign' }));
            }}
          >
            More options…
          </button>
        </>
      }
    />
  );
};
