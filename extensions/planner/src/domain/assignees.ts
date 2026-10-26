// Agents to assign tasks to, as in GitHub or Linear: OpenCode agents, each with
// an optional model, named as presets in Settings → Agents. Every assignee is an
// OpenCode command, `oc-planner-<id>`, whose frontmatter names the agent and the
// model; a chat that starts with `/oc-planner-<id> <instructions>` switches to
// them and gets the instructions as its first message.
import type { AgentPreset, PlannerState, RunAssignee } from './types.ts';

/** An OpenCode agent that can take a chat: built in, or from OpenCode's config. */
export interface DiscoveredAgent {
  /** OpenCode's agent id: build, plan, review/strict. */
  name: string;
  label: string;
  description: string | null;
  /** The model the agent is bound to in its config. */
  model: string | null;
  color: string | null;
  source: 'built-in' | 'global' | 'project';
}

/** A model OpenCode can run, as `provider/model`. */
export interface ModelInfo {
  id: string;
  /** OpenCode's display name, when the running server gave one. */
  name: string | null;
  variants: string[];
}

/** What the service found: the agents, their default, and the models. */
export interface AgentCatalog {
  agents: DiscoveredAgent[];
  defaultAgent: string | null;
  models: ModelInfo[];
  modelsError: string | null;
  /** OpenCode's global config folder, where the commands go. */
  configDir: string;
}

export const COMMAND_PREFIX = 'oc-planner-';

/** First line of every command file the Planner writes; it only ever changes or removes files that have it. */
export const COMMAND_MARKER = '# Written by the OpenChamber Planner';

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
/** `provider/model` or `provider/model#variant`, as OpenCode's config takes it. */
const MODEL_REF = /^[^\s/#]{1,64}\/[^\s#]{1,160}(?:#[^\s#]{1,40})?$/;
const ASSIGNEE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

export const isAgentName = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && AGENT_NAME.test(value);
export const isModelRef = (value: unknown): value is string => typeof value === 'string' && MODEL_REF.test(value);
export const isAssigneeId = (value: unknown): value is string => typeof value === 'string' && ASSIGNEE_ID.test(value);
// Shown in chats and menus and written into a command's description: one line of ordinary text.
export const isPresetName = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 60 && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(value);

export const isAgentPreset = (value: unknown): value is AgentPreset => {
  const preset = value as Partial<AgentPreset> | null;
  return typeof preset === 'object' && preset !== null && isAssigneeId(preset.id) && isPresetName(preset.name) && isAgentName(preset.agent) && (preset.model === null || isModelRef(preset.model));
};

export const isRunAssignee = (value: unknown): value is RunAssignee => {
  const assignee = value as Partial<RunAssignee> | null;
  return typeof assignee === 'object' && assignee !== null && isAssigneeId(assignee.id) && isPresetName(assignee.name) && isAgentName(assignee.agent) && (assignee.model === null || isModelRef(assignee.model));
};

/** Lowercase letters, digits and single dashes. */
export const slug = (text: string, max = 40): string =>
  text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');

/** A preset's id: its name, readable in OpenCode's command list, and a few random letters. */
export const newPresetId = (name: string, random: string): string => `${slug(name, 32) || 'agent'}-${random.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4) || 'x'}`;

export const commandName = (assignee: Pick<RunAssignee, 'id'>): string => `${COMMAND_PREFIX}${assignee.id}`;

/** The model without its provider: anthropic/claude-sonnet-5-5#high → claude-sonnet-5-5 (high). */
export const modelLabel = (model: string): string => {
  const [ref, variant] = model.split('#');
  const name = ref!.slice(ref!.indexOf('/') + 1);
  return variant ? `${name} (${variant})` : name;
};

/** "Build · claude-sonnet-5-5", or just "Build". */
export const presetName = (agentLabel: string, model: string | null): string => (model ? `${agentLabel} · ${modelLabel(model)}` : agentLabel).slice(0, 60);

export const agentLabel = (name: string): string => (name === 'build' ? 'Build' : name === 'plan' ? 'Plan' : name.charAt(0).toUpperCase() + name.slice(1));

export const presetAssignee = (preset: AgentPreset): RunAssignee => ({ id: preset.id, name: preset.name, agent: preset.agent, model: preset.model });

/** An agent with no preset runs on the model its config gives it, else OpenChamber's. */
export const agentAssignee = (agent: Pick<DiscoveredAgent, 'name' | 'label'>): RunAssignee => ({ id: `agent-${slug(agent.name.replace(/\//g, '-'), 40) || 'x'}`, name: agent.label.slice(0, 60), agent: agent.name, model: null });

/** One row of the assignee picker. */
export interface AssigneeOption extends RunAssignee {
  kind: 'preset' | 'agent';
  /** What to show under the name. */
  detail: string;
  color: string | null;
  /** A preset whose agent OpenCode no longer has. */
  missing: boolean;
}

/** Presets first, in the order they were made, then every agent OpenCode can start a chat with. */
export const assigneeOptions = (presets: readonly AgentPreset[], agents: readonly DiscoveredAgent[]): AssigneeOption[] => {
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  return [
    ...presets.map((preset): AssigneeOption => {
      const agent = byName.get(preset.agent);
      return {
        ...presetAssignee(preset),
        kind: 'preset',
        detail: `${agent?.label ?? preset.agent} · ${preset.model ?? (agent?.model ? `${agent.model} (its own)` : "the agent's model")}`,
        color: agent?.color ?? null,
        missing: agents.length > 0 && !agent,
      };
    }),
    ...agents.map((agent): AssigneeOption => ({
      ...agentAssignee(agent),
      kind: 'agent',
      detail: [agent.model ?? null, agent.description].filter(Boolean).join(' · ') || (agent.source === 'built-in' ? 'Built in' : 'From OpenCode config'),
      color: agent.color,
      missing: false,
    })),
  ];
};

/** Does `option` match what was typed: every word somewhere in its name, agent, model or description. */
export const matchesQuery = (option: Pick<AssigneeOption, 'name' | 'agent' | 'model' | 'detail'>, query: string): boolean => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${option.name} ${option.agent} ${option.model ?? ''} ${option.detail}`.toLowerCase();
  return words.every((word) => text.includes(word));
};

/**
 * OpenCode runs every `` !`…` `` in a command's text as a shell command, after
 * the arguments are put in. Issue titles and descriptions travel in the
 * arguments, so a zero-width space goes between every `!` and backtick: the
 * text reads the same and nothing runs.
 */
export const neutralizeShell = (text: string): string => text.replace(/!`/g, '!\u200b`');

/**
 * The first message that starts a chat as `assignee`: OpenChamber sends a
 * message that starts with `/name ` through OpenCode's command route, and the
 * rest after the first space becomes the command's arguments.
 */
export const commandText = (command: string, instructions: string): string => `/${command} ${neutralizeShell(instructions)}`;

/** The command file for `assignee`: its agent and model in the frontmatter, the arguments as the whole text. */
export const commandFile = (assignee: RunAssignee, kind: 'preset' | 'agent'): string =>
  [
    '---',
    `${COMMAND_MARKER} (${kind}); it rewrites and removes this file.`,
    `description: ${JSON.stringify(`Planner: a task assigned to ${assignee.name}`)}`,
    `agent: ${JSON.stringify(assignee.agent)}`,
    ...(assignee.model ? [`model: ${JSON.stringify(assignee.model)}`] : []),
    '---',
    '$ARGUMENTS',
    '',
  ].join('\n');

/** Up to two letters for an avatar: "Build · Claude" → BC, "review/strict" → RS. */
export const initials = (name: string): string => {
  const words = name.split(/[\s·/_.-]+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
  const letters = words.length > 1 ? [words[0]!, words[1]!].map((word) => [...word][0]) : [...(words[0] ?? '?')].slice(0, 2);
  return letters.join('').toUpperCase() || '?';
};

const AVATAR_COLORS = ['#5e6ad2', '#0f9d58', '#e8590c', '#1c7ed6', '#ae3ec9', '#0c8599', '#e64980', '#5c940d'] as const;

/** A steady color for an assignee without one of its own. */
export const avatarColor = (id: string, own?: string | null): string => {
  if (own && /^#[0-9a-fA-F]{6}$/.test(own)) return own;
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
};

/** Who a task is assigned to: the assignees of its runs, the latest first, each once. */
export const taskAssignees = (state: PlannerState, taskId: string): RunAssignee[] => {
  const seen = new Set<string>();
  return Object.values(state.runs)
    .filter((run) => run.taskId === taskId && run.assignee)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .flatMap((run) => {
      if (seen.has(run.assignee!.id)) return [];
      seen.add(run.assignee!.id);
      return [run.assignee!];
    });
};

/** The assignee a new assignment starts on: the task's last one, else the first preset, else Build. */
export const defaultAssignee = (state: PlannerState, taskId: string | null, options: readonly AssigneeOption[]): AssigneeOption | null => {
  const last = taskId ? taskAssignees(state, taskId)[0] : undefined;
  return options.find((option) => option.id === last?.id) ?? options.find((option) => option.kind === 'preset' && !option.missing) ?? options.find((option) => option.agent === 'build') ?? options[0] ?? null;
};
