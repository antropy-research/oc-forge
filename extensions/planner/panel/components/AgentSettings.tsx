import { useEffect, useState } from 'preact/hooks';
import { agentLabel, isAgentPreset, newPresetId, presetName, type DiscoveredAgent, type ModelInfo } from '../../src/domain/assignees.ts';
import { newId } from '../../src/domain/ids.ts';
import type { AgentPreset } from '../../src/domain/types.ts';
import { useAgents, usePlanner, useView } from '../lib/context.ts';
import { Avatar } from './AssigneePicker.tsx';

const SOURCE_LABEL: Record<DiscoveredAgent['source'], string> = { 'built-in': 'built in', global: 'OpenCode config', project: 'project' };

/** `provider/model#variant` in its two parts. */
const splitModel = (model: string | null): { base: string; variant: string } => {
  const [base, variant] = (model ?? '').split('#');
  return { base: base ?? '', variant: variant ?? '' };
};
const joinModel = (base: string, variant: string): string | null => (base ? `${base}${variant.trim() ? `#${variant.trim()}` : ''}` : null);

/** The agent choices: OpenCode's, and the one a preset names even when OpenCode no longer has it. */
const AgentOptions = ({ agents, current }: { agents: DiscoveredAgent[]; current: string }) => (
  <>
    {agents.map((agent) => <option key={agent.name} value={agent.name}>{agent.label}</option>)}
    {current && !agents.some((agent) => agent.name === current) && <option value={current}>{current} (not found)</option>}
  </>
);

const ModelOptions = ({ models, current }: { models: ModelInfo[]; current: string }) => (
  <>
    <option value="">The agent's own model</option>
    {models.map((model) => <option key={model.id} value={model.id}>{model.name ? `${model.name} · ${model.id}` : model.id}</option>)}
    {current && !models.some((model) => model.id === current) && <option value={current}>{current} (not listed now)</option>}
  </>
);

/** A variant: the model's own list when OpenCode gave one, else free text (high, max…). */
const VariantInput = ({ models, base, value, label, onChange }: { models: ModelInfo[]; base: string; value: string; label: string; onChange: (value: string) => void }) => {
  const variants = models.find((model) => model.id === base)?.variants ?? [];
  if (variants.length)
    return (
      <select aria-label={label} value={value} onChange={(event) => onChange(event.currentTarget.value)}>
        <option value="">Default effort</option>
        {variants.map((variant) => <option key={variant} value={variant}>{variant}</option>)}
        {value && !variants.includes(value) && <option value={value}>{value}</option>}
      </select>
    );
  return <input aria-label={label} placeholder="Variant" value={value} disabled={!base} onChange={(event) => onChange(event.currentTarget.value)} />;
};

const PresetRow = ({ preset, agents, models, onSave, onRemove }: { preset: AgentPreset; agents: DiscoveredAgent[]; models: ModelInfo[]; onSave: (next: AgentPreset) => void; onRemove: () => void }) => {
  const { base, variant } = splitModel(preset.model);
  const update = (patch: Partial<AgentPreset>) => onSave({ ...preset, ...patch });
  return (
    <li class="preset-row" aria-label={`Preset ${preset.name}`}>
      <Avatar name={preset.name} id={preset.id} color={agents.find((agent) => agent.name === preset.agent)?.color} />
      <input aria-label={`${preset.name} name`} defaultValue={preset.name} key={preset.name} onBlur={(event) => event.currentTarget.value.trim() && event.currentTarget.value.trim() !== preset.name && update({ name: event.currentTarget.value.trim() })} onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()} />
      <select aria-label={`${preset.name} agent`} value={preset.agent} onChange={(event) => update({ agent: event.currentTarget.value })}>
        <AgentOptions agents={agents} current={preset.agent} />
      </select>
      <select aria-label={`${preset.name} model`} value={base} onChange={(event) => update({ model: joinModel(event.currentTarget.value, '') })}>
        <ModelOptions models={models} current={base} />
      </select>
      <VariantInput models={models} base={base} value={variant} label={`${preset.name} variant`} onChange={(next) => update({ model: joinModel(base, next) })} />
      <button class="link danger" aria-label={`Remove the preset ${preset.name}`} onClick={onRemove}>Remove</button>
    </li>
  );
};

/**
 * Settings → Agents: named presets of an OpenCode agent and a model ("Build ·
 * Claude", "Plan · GPT-6") to assign tasks to, beside OpenCode's own agents.
 * Each preset is an OpenCode command the service keeps in OpenCode's config.
 */
export const AgentSettings = () => {
  const { client, agents } = usePlanner();
  const view = useView();
  const av = useAgents();
  const presets = view.state.settings.agentPresets ?? [];
  const catalog = av.catalog;
  const found = catalog?.agents ?? [];
  const models = catalog?.models ?? [];
  const [agent, setAgent] = useState('build');
  const [model, setModel] = useState('');
  const [variant, setVariant] = useState('');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    void agents.loadCatalog(null);
  }, [agents]);
  const save = (next: AgentPreset[], undo?: string) => void client.dispatch([{ type: 'settings.updated', patch: { agentPresets: next } }], undo ? { undo } : {});
  const label = found.find((item) => item.name === agent)?.label ?? agentLabel(agent);
  const ref = joinModel(model, variant);
  const suggested = presetName(label, ref);
  const add = () => {
    const preset: AgentPreset = { id: newPresetId(name.trim() || suggested, newId().slice(-4)), name: (name.trim() || suggested).slice(0, 60), agent, model: ref };
    if (!isAgentPreset(preset)) {
      setProblem('A preset needs a name on one line, an agent, and a model as provider/model.');
      return;
    }
    setProblem(null);
    save([...presets, preset]);
    setName('');
    setModel('');
    setVariant('');
  };
  return (
    <fieldset aria-label="Agents">
      <legend>Agents</legend>
      <p class="hint">
        Assign a task to an agent as in GitHub or Linear: an OpenCode agent on the model you choose works on it in a new worktree and opens a pull request. Each preset is an
        OpenCode command the Planner keeps in <code>{catalog ? `${catalog.configDir}/command` : '~/.config/opencode/command'}</code>, which starts the chat as that agent and model.
      </p>
      <ul class="preset-list" aria-label="Agent presets">
        {presets.map((preset) => (
          <PresetRow
            key={preset.id}
            preset={preset}
            agents={found}
            models={models}
            onSave={(next) => (isAgentPreset(next) ? save(presets.map((item) => (item.id === preset.id ? next : item))) : setProblem('That preset would not be valid.'))}
            onRemove={() => save(presets.filter((item) => item.id !== preset.id), `Removed the preset ${preset.name}`)}
          />
        ))}
        {presets.length === 0 && <li class="hint">No presets yet. Tasks can still be assigned to Build, Plan or your own agents, on their own models.</li>}
      </ul>
      <div class="row preset-add" role="group" aria-label="New agent preset">
        <select aria-label="Preset agent" value={agent} onChange={(event) => setAgent(event.currentTarget.value)}>
          <AgentOptions agents={found.length ? found : [{ name: 'build', label: 'Build', description: null, model: null, color: null, source: 'built-in' }, { name: 'plan', label: 'Plan', description: null, model: null, color: null, source: 'built-in' }]} current={agent} />
        </select>
        <select aria-label="Preset model" value={model} onChange={(event) => { setModel(event.currentTarget.value); setVariant(''); }}>
          <ModelOptions models={models} current={model} />
        </select>
        <VariantInput models={models} base={model} value={variant} label="Preset variant" onChange={setVariant} />
        <input class="grow" aria-label="Preset name" placeholder={suggested} value={name} onInput={(event) => setName(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && add()} />
        <button onClick={add}>Add preset</button>
      </div>
      {problem && <p class="feed-errors" role="alert">{problem}</p>}
      <details class="agent-catalog">
        <summary>
          What OpenCode offers: {av.catalogLoading && !catalog ? 'looking…' : `${found.length} agent${found.length === 1 ? '' : 's'}, ${models.length} model${models.length === 1 ? '' : 's'}`}
        </summary>
        <ul aria-label="OpenCode agents">
          {found.map((item) => (
            <li key={item.name}>
              <Avatar name={item.label} id={`agent-${item.name}`} color={item.color} small />
              <strong>{item.label}</strong>
              <span class="ws-badge is-source">{SOURCE_LABEL[item.source]}</span>
              <span class="muted">{[item.model, item.description].filter(Boolean).join(' · ')}</span>
            </li>
          ))}
        </ul>
        {catalog?.modelsError && <p class="hint">{catalog.modelsError}</p>}
        {av.catalogError && <p class="feed-errors" role="alert">{av.catalogError}</p>}
        <button class="link" onClick={() => void agents.loadCatalog(null, true)}>Look again</button>
      </details>
    </fieldset>
  );
};
