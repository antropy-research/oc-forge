// OpenCode agents and models to assign tasks to, and the commands that start a
// chat as one of them. The service runs where OpenCode runs, so it reads
// OpenCode's config folders, asks the `opencode` CLI for the models (and, when
// OpenCode's background server is up, for its live agents and commands), and
// writes one command per assignee into OpenCode's global command folder.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type http from 'node:http';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  COMMAND_MARKER,
  COMMAND_PREFIX,
  agentLabel,
  commandFile,
  commandName,
  isAgentName,
  isModelRef,
  isRunAssignee,
  presetAssignee,
  type AgentCatalog,
  type DiscoveredAgent,
  type ModelInfo,
} from '../src/domain/assignees.ts';
import type { AgentPreset, RunAssignee } from '../src/domain/types.ts';

/** OpenCode's global config folder: `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`. */
export const opencodeConfigDir = (env: NodeJS.ProcessEnv = process.env): string =>
  env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'opencode') : join(env.HOME || homedir(), '.config', 'opencode');

type Scalar = string | number | boolean | null;

const scalar = (raw: string): Scalar => {
  const text = raw.trim();
  if (text.startsWith('"')) {
    const end = text.lastIndexOf('"');
    try {
      return JSON.parse(text.slice(0, end + 1)) as string;
    } catch {
      return text.slice(1, end > 0 ? end : undefined);
    }
  }
  if (text.startsWith("'")) {
    const end = text.lastIndexOf("'");
    return text.slice(1, end > 0 ? end : undefined).replace(/''/g, "'");
  }
  const value = text.replace(/\s+#.*$/, '').trim();
  if (value === '' || value === '~' || value === 'null' || value === '|' || value === '>' || value === '|-' || value === '>-') return null;
  if (value === 'true' || value === 'false') return value === 'true';
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
};

/**
 * The top-level `key: value` lines of a Markdown file's YAML frontmatter, which
 * is all an agent file needs here; nested keys and block scalars are skipped.
 * A file without frontmatter has none (OpenCode still reads it as an agent).
 */
export const parseFrontmatter = (text: string): Record<string, Scalar> => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const data: Record<string, Scalar> = {};
  if (!match) return data;
  for (const line of match[1]!.split(/\r?\n/)) {
    if (!line.trim() || /^\s/.test(line) || line.trimStart().startsWith('#')) continue;
    const entry = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/.exec(line);
    if (entry) data[entry[1]!] = scalar(entry[2]!);
  }
  return data;
};

/** JSON with comments and trailing commas, as `opencode.jsonc` allows. */
export const parseJsonc = (text: string): unknown => {
  let out = '';
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (inString) {
      out += char;
      if (char === '\\') out += text[++index] ?? '';
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index++;
      out += '\n';
    } else if (char === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++;
      index++;
    } else if (char === ',') {
      // A comma with nothing after it but a closing bracket is dropped.
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next]!)) next++;
      if (text[next] !== '}' && text[next] !== ']') out += char;
    } else out += char;
  }
  return JSON.parse(out);
};

interface AgentEntry {
  label: string;
  description: string | null;
  model: string | null;
  color: string | null;
  mode: 'primary' | 'subagent' | 'all';
  hidden: boolean;
  source: DiscoveredAgent['source'];
}

/** OpenCode 2.1's own agents; general and explore are subagents, the last three internal. */
const BUILT_IN: Record<string, Pick<AgentEntry, 'label' | 'description' | 'mode' | 'hidden'>> = {
  build: { label: 'Build', description: 'The default agent. Executes tools based on configured permissions.', mode: 'primary', hidden: false },
  plan: { label: 'Plan', description: 'Read-only agent for exploring the codebase and planning work before implementation.', mode: 'primary', hidden: false },
  general: { label: 'General', description: 'General-purpose agent for researching complex questions and executing multi-step tasks.', mode: 'subagent', hidden: false },
  explore: { label: 'Explore', description: 'Fast agent specialized for exploring codebases.', mode: 'subagent', hidden: false },
  compaction: { label: 'Compaction', description: null, mode: 'primary', hidden: true },
  title: { label: 'Title', description: null, mode: 'primary', hidden: true },
  summary: { label: 'Summary', description: null, mode: 'primary', hidden: true },
};

const MAX_FILES = 300;
const MAX_FILE_BYTES = 256_000;

const readSmall = (file: string): string | null => {
  try {
    const stat = statSync(file);
    return stat.isFile() && stat.size <= MAX_FILE_BYTES ? readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
};

/** Markdown files under `dir`, as names relative to it without `.md`. */
const markdownFiles = (dir: string, recursive: boolean, budget: { left: number }): { name: string; file: string }[] => {
  const found: { name: string; file: string }[] = [];
  const walk = (current: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(current).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget.left <= 0) return;
      const file = join(current, entry);
      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      if (stat.isDirectory() && recursive && depth < 4) walk(file, depth + 1);
      else if (stat.isFile() && entry.endsWith('.md')) {
        budget.left--;
        found.push({ name: relative(dir, file).split(sep).join('/').replace(/\.md$/, ''), file });
      }
    }
  };
  walk(dir, 0);
  return found;
};

/**
 * The primary agents OpenCode's config gives, the way OpenCode 2.1 reads it:
 * the built-in agents, then the global config folder (`opencode.json(c)`'s
 * `agents`, or v1's `agent`, then `agent/`, `agents/` and `mode/` Markdown
 * files), then the project's (`opencode.json(c)` and `.opencode/`), later ones
 * overriding earlier ones. Subagents, hidden and disabled agents are left out:
 * a chat cannot start as one.
 */
export const discoverAgents = (configDir: string, projectDir?: string | null): { agents: DiscoveredAgent[]; defaultAgent: string | null } => {
  const agents = new Map<string, AgentEntry>(Object.entries(BUILT_IN).map(([name, entry]) => [name, { ...entry, model: null, color: null, source: 'built-in' as const }]));
  let defaultAgent: string | null = null;
  const budget = { left: MAX_FILES };

  const apply = (name: string, def: Record<string, unknown>, source: DiscoveredAgent['source']) => {
    if (!isAgentName(name)) return;
    if (def.disabled === true || def.disable === true) {
      agents.delete(name);
      return;
    }
    const entry: AgentEntry = agents.get(name) ?? { label: agentLabel(name), description: null, model: null, color: null, mode: 'primary', hidden: false, source };
    if (def.mode === 'primary' || def.mode === 'subagent' || def.mode === 'all') entry.mode = def.mode;
    if (typeof def.hidden === 'boolean') entry.hidden = def.hidden;
    if (typeof def.description === 'string' && def.description.trim()) entry.description = def.description.trim().slice(0, 300);
    if (typeof def.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(def.color)) entry.color = def.color;
    if (typeof def.model === 'string') {
      // v1 kept the variant apart from the model.
      const model = !def.model.includes('#') && typeof def.variant === 'string' ? `${def.model}#${def.variant}` : def.model;
      if (isModelRef(model)) entry.model = model;
    }
    agents.set(name, entry);
  };

  const fromJson = (file: string, source: DiscoveredAgent['source']) => {
    const text = readSmall(file);
    if (text === null) return;
    let data: unknown;
    try {
      data = parseJsonc(text);
    } catch {
      return;
    }
    const config = data as { agents?: unknown; agent?: unknown; default_agent?: unknown } | null;
    if (!config || typeof config !== 'object') return;
    for (const key of ['agent', 'agents'] as const) {
      const block = config[key];
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
      for (const [name, def] of Object.entries(block as Record<string, unknown>)) {
        if (def && typeof def === 'object' && !Array.isArray(def)) apply(name, def as Record<string, unknown>, source);
      }
    }
    if (typeof config.default_agent === 'string' && isAgentName(config.default_agent)) defaultAgent = config.default_agent;
  };

  const fromFolder = (dir: string, source: DiscoveredAgent['source']) => {
    for (const sub of ['agent', 'agents']) {
      for (const { name, file } of markdownFiles(join(dir, sub), true, budget)) {
        const text = readSmall(file);
        if (text !== null) apply(name, parseFrontmatter(text), source);
      }
    }
    // Files in mode/ are primary agents whatever they say.
    for (const sub of ['mode', 'modes']) {
      for (const { name, file } of markdownFiles(join(dir, sub), false, budget)) {
        const text = readSmall(file);
        if (text !== null) apply(name, { ...parseFrontmatter(text), mode: 'primary' }, source);
      }
    }
  };

  fromJson(join(configDir, 'opencode.json'), 'global');
  fromJson(join(configDir, 'opencode.jsonc'), 'global');
  fromFolder(configDir, 'global');
  if (projectDir && isAbsolute(projectDir) && existsSync(projectDir)) {
    fromJson(join(projectDir, 'opencode.json'), 'project');
    fromJson(join(projectDir, 'opencode.jsonc'), 'project');
    fromJson(join(projectDir, '.opencode', 'opencode.json'), 'project');
    fromJson(join(projectDir, '.opencode', 'opencode.jsonc'), 'project');
    fromFolder(join(projectDir, '.opencode'), 'project');
  }
  return { agents: orderAgents([...agents].filter(([, entry]) => entry.mode !== 'subagent' && !entry.hidden).map(([name, entry]) => toAgent(name, entry))), defaultAgent };
};

const toAgent = (name: string, entry: AgentEntry): DiscoveredAgent => ({ name, label: entry.label, description: entry.description, model: entry.model, color: entry.color, source: entry.source });

/** Build and Plan first, as OpenCode lists them, then the others by name. */
const orderAgents = (agents: DiscoveredAgent[]): DiscoveredAgent[] => {
  const rank = (name: string) => (name === 'build' ? 0 : name === 'plan' ? 1 : 2);
  return agents.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
};

/** `opencode models` prints one `provider/model` a line. */
export const parseModels = (out: string): string[] => [...new Set(out.split(/\r?\n/).map((line) => line.trim()).filter((line) => isModelRef(line) && !line.includes('#')))].sort((a, b) => a.localeCompare(b));

const dataOf = (json: unknown): unknown[] => {
  const data = (json as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data : [];
};

/** Display names and variants from the running server's `GET /api/model`. */
export const parseModelDetails = (json: unknown): Map<string, { name: string | null; variants: string[] }> => {
  const details = new Map<string, { name: string | null; variants: string[] }>();
  for (const item of dataOf(json)) {
    const model = item as { id?: unknown; providerID?: unknown; name?: unknown; variants?: unknown };
    if (typeof model.id !== 'string' || typeof model.providerID !== 'string') continue;
    const id = `${model.providerID}/${model.id}`;
    if (!isModelRef(id)) continue;
    const variants = Array.isArray(model.variants)
      ? model.variants.flatMap((variant) => {
          const value = typeof variant === 'string' ? variant : (variant as { id?: unknown; name?: unknown } | null)?.id ?? (variant as { name?: unknown } | null)?.name;
          return typeof value === 'string' && /^[^\s#]{1,40}$/.test(value) ? [value] : [];
        })
      : [];
    details.set(id, { name: typeof model.name === 'string' && model.name.trim() ? model.name.trim().slice(0, 80) : null, variants });
  }
  return details;
};

/** The running server's agents (`GET /api/agent`), the ones a chat can start as. */
export const parseLiveAgents = (json: unknown): DiscoveredAgent[] =>
  dataOf(json).flatMap((item): DiscoveredAgent[] => {
    const agent = item as { id?: unknown; name?: unknown; mode?: unknown; hidden?: unknown; description?: unknown; color?: unknown; model?: unknown };
    if (!isAgentName(agent.id) || agent.mode === 'subagent' || agent.hidden === true) return [];
    const ref = agent.model as { providerID?: unknown; id?: unknown; variant?: unknown } | undefined;
    const model = ref && typeof ref.providerID === 'string' && typeof ref.id === 'string' ? `${ref.providerID}/${ref.id}${typeof ref.variant === 'string' && ref.variant ? `#${ref.variant}` : ''}` : null;
    return [{
      name: agent.id,
      label: typeof agent.name === 'string' && agent.name.trim() ? agent.name.trim().slice(0, 60) : agentLabel(agent.id),
      description: typeof agent.description === 'string' && agent.description.trim() ? agent.description.trim().slice(0, 300) : null,
      model: model && isModelRef(model) ? model : null,
      color: typeof agent.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(agent.color) ? agent.color : null,
      source: 'global',
    }];
  });

/** Command names from the running server's `GET /api/command`. */
export const parseCommandNames = (json: unknown): string[] =>
  dataOf(json).flatMap((item) => {
    const name = (item as { name?: unknown } | null)?.name;
    return typeof name === 'string' ? [name] : [];
  });

/** Runs the `opencode` CLI; `cwd` is the folder OpenCode answers for. */
export type OpenCodeRunner = (args: string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<string>;

export const opencodeRunner: OpenCodeRunner = (args, options) =>
  new Promise((resolve, reject) => {
    execFile('opencode', args, { timeout: options?.timeoutMs ?? 10_000, maxBuffer: 16_000_000, ...(options?.cwd ? { cwd: options.cwd } : {}), env: { ...process.env, NO_COLOR: '1' } }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(`${error.message}\n${stderr}`), { code: (error as NodeJS.ErrnoException).code, stderr: String(stderr) }));
      else resolve(stdout);
    });
  });

const MODELS_TTL_MS = 10 * 60_000;
const AGENTS_TTL_MS = 60_000;
const STATUS_TTL_MS = 30_000;
/** How long a request waits for the first model list; the agents answer without it, and the panel asks again. */
const MODELS_WAIT_MS = 3_000;
const LISTED_WAIT_MS = 6_000;
const LISTED_POLL_MS = 300;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const messageOf = (error: unknown): string => {
  const failure = error as { code?: string; stderr?: string; message?: string };
  if (failure.code === 'ENOENT') return 'The OpenCode CLI (opencode) is not on the PATH where OpenChamber runs.';
  return `${failure.stderr || failure.message || String(error)}`.trim().split('\n')[0]!.slice(0, 300);
};

const locationQuery = (directory: string) => `location%5Bdirectory%5D=${encodeURIComponent(directory)}`;

/**
 * What the `opencode` CLI can tell: the models, and, while OpenCode's
 * background server runs (the one OpenChamber talks to), its agents and
 * commands. It never starts that server: when it is stopped, the models come
 * from a private one (`--standalone`) that ends with the command.
 */
export class OpenCodeInfo {
  private status: { url: string | null; at: number } | null = null;
  private models: { at: number; list: ModelInfo[]; error: string | null } | null = null;
  private loadingModels: Promise<void> | null = null;
  private readonly live = new Map<string, { at: number; agents: DiscoveredAgent[] | null }>();

  constructor(private readonly run: OpenCodeRunner = opencodeRunner, private readonly now: () => number = Date.now) {}

  /** The background server's address, or null when it is stopped or the CLI is missing. */
  async server(): Promise<string | null> {
    if (this.status && this.now() - this.status.at < STATUS_TTL_MS) return this.status.url;
    let url: string | null = null;
    try {
      const out = (await this.run(['service', 'status'], { timeoutMs: 5_000 })).trim();
      url = /^https?:\/\//.test(out) ? out : null;
    } catch {
      url = null;
    }
    this.status = { url, at: this.now() };
    return url;
  }

  private async api(path: string): Promise<unknown> {
    return JSON.parse(await this.run(['api', 'GET', path], { timeoutMs: 6_000 }));
  }

  /** The models, from a cache refreshed every ten minutes; waits at most 3 s for the first list, then says it is pending. */
  async modelList(directory: string | null, refresh = false): Promise<{ models: ModelInfo[]; error: string | null; pending?: boolean }> {
    const stale = !this.models || refresh || this.now() - this.models.at > MODELS_TTL_MS;
    if (stale && !this.loadingModels) {
      this.loadingModels = this.loadModels(directory).finally(() => {
        this.loadingModels = null;
      });
    }
    if (this.models && !refresh) return { models: this.models.list, error: this.models.error };
    const done = await Promise.race([this.loadingModels!.then(() => true), sleep(MODELS_WAIT_MS).then(() => false)]);
    if (!done || !this.models) return { models: this.models?.list ?? [], error: null, pending: true };
    return { models: this.models.list, error: this.models.error };
  }

  private async loadModels(directory: string | null): Promise<void> {
    const cwd = directory && isAbsolute(directory) && existsSync(directory) ? directory : undefined;
    try {
      const running = await this.server();
      const ids = parseModels(await this.run(running ? ['models'] : ['models', '--standalone'], { cwd, timeoutMs: running ? 10_000 : 15_000 }));
      // Names and variants are a nicety; the running server has them.
      const details = running ? await this.api(`/api/model?${locationQuery(cwd ?? homedir())}`).then(parseModelDetails).catch(() => new Map()) : new Map();
      this.models = { at: this.now(), list: ids.map((id) => ({ id, name: details.get(id)?.name ?? null, variants: details.get(id)?.variants ?? [] })), error: ids.length ? null : 'OpenCode lists no models; connect a provider in OpenChamber.' };
    } catch (error) {
      this.models = { at: this.now(), list: this.models?.list ?? [], error: messageOf(error) };
    }
  }

  /** The agents the running server has for `directory`, or null when it cannot be asked. */
  async liveAgents(directory: string): Promise<DiscoveredAgent[] | null> {
    const cached = this.live.get(directory);
    if (cached && this.now() - cached.at < AGENTS_TTL_MS) return cached.agents;
    let agents: DiscoveredAgent[] | null = null;
    if (await this.server()) agents = await this.api(`/api/agent?${locationQuery(directory)}`).then(parseLiveAgents).catch(() => null);
    this.live.set(directory, { at: this.now(), agents });
    return agents;
  }

  /** The commands the running server lists for `directory`, or null when it cannot be asked. */
  async commands(directory: string): Promise<string[] | null> {
    if (!(await this.server())) return null;
    return this.api(`/api/command?${locationQuery(directory)}`).then(parseCommandNames).catch(() => null);
  }

  /**
   * Wait until OpenCode lists every one of `names` for `directory` (it reloads
   * commands 100 ms after a file changes): true once listed, false when it did
   * not within six seconds, null when the server cannot be asked.
   */
  async waitListed(names: readonly string[], directory: string): Promise<boolean | null> {
    const until = this.now() + LISTED_WAIT_MS;
    for (;;) {
      const listed = await this.commands(directory);
      if (listed === null) return null;
      if (names.every((name) => listed.includes(name))) return true;
      if (this.now() >= until) return false;
      await sleep(LISTED_POLL_MS);
    }
  }
}

/** Agents from the config files, checked against the running server when it can be asked. */
export const mergeAgents = (fromConfig: readonly DiscoveredAgent[], live: readonly DiscoveredAgent[] | null): DiscoveredAgent[] => {
  if (!live) return [...fromConfig];
  const known = new Map(fromConfig.map((agent) => [agent.name, agent]));
  // The server is the truth for which agents exist; the files say where they come from.
  return orderAgents(live.map((agent) => ({ ...agent, source: known.get(agent.name)?.source ?? agent.source, description: agent.description ?? known.get(agent.name)?.description ?? null })));
};

/** The command files in OpenCode's global `command/` folder, one per assignee. */
export class CommandFiles {
  private lastPresets: string | null = null;

  constructor(readonly configDir: string, private readonly log: (message: string) => void = () => {}) {}

  get dir(): string {
    return join(this.configDir, 'command');
  }

  /** Write the commands for these assignees; which ones changed on disk. Never touches a file the Planner did not write. */
  ensure(entries: readonly { assignee: RunAssignee; kind: 'preset' | 'agent' }[]): { id: string; name: string; changed: boolean }[] {
    if (entries.length === 0) return [];
    mkdirSync(this.dir, { recursive: true });
    return entries.map(({ assignee, kind }) => {
      const name = commandName(assignee);
      const file = join(this.dir, `${name}.md`);
      const content = commandFile(assignee, kind);
      const current = readSmall(file);
      if (current === content) return { id: assignee.id, name, changed: false };
      if (current !== null && !current.includes(COMMAND_MARKER)) throw new Error(`${file} exists and was not written by the Planner`);
      // OpenCode reads command/**/*.md; the temporary name is not one of them.
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, content, { mode: 0o644 });
      renameSync(temporary, file);
      return { id: assignee.id, name, changed: true };
    });
  }

  /** A command for every preset, and none left for presets that are gone; only when the presets changed. */
  syncPresets(presets: readonly AgentPreset[]): void {
    const key = JSON.stringify(presets);
    if (key === this.lastPresets) return;
    try {
      this.ensure(presets.map((preset) => ({ assignee: presetAssignee(preset), kind: 'preset' as const })));
      const wanted = new Set(presets.map((preset) => `${commandName(preset)}.md`));
      let files: string[] = [];
      try {
        files = readdirSync(this.dir);
      } catch {
        files = [];
      }
      for (const file of files) {
        if (!file.startsWith(COMMAND_PREFIX) || !file.endsWith('.md') || wanted.has(file)) continue;
        if (readSmall(join(this.dir, file))?.startsWith(`---\n${COMMAND_MARKER} (preset)`)) rmSync(join(this.dir, file), { force: true });
      }
      this.lastPresets = key;
    } catch (error) {
      this.log(`agent commands: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export interface AgentDeps {
  configDir: string;
  info: OpenCodeInfo;
  commands: CommandFiles;
  readJson: (req: http.IncomingMessage) => Promise<unknown>;
}

const isDirectory = (value: unknown): value is string => typeof value === 'string' && value.length <= 1024 && isAbsolute(value);

/** The catalog for the assignee picker and Settings → Agents. */
export const agentCatalog = async (deps: Pick<AgentDeps, 'configDir' | 'info'>, directory: string | null, refresh: boolean): Promise<AgentCatalog> => {
  const fromConfig = discoverAgents(deps.configDir, directory);
  const [live, models] = await Promise.all([deps.info.liveAgents(directory ?? homedir()), deps.info.modelList(directory, refresh)]);
  return { agents: mergeAgents(fromConfig.agents, live), defaultAgent: fromConfig.defaultAgent, models: models.models, modelsError: models.error, ...(models.pending ? { modelsPending: true } : {}), configDir: deps.configDir };
};

/** The agent routes; null when the path is not one of them. */
export const agentRoute = async (req: http.IncomingMessage, url: URL, deps: AgentDeps): Promise<{ status: number; body: unknown } | null> => {
  if (url.pathname === '/agents' && req.method === 'GET') {
    const directory = url.searchParams.get('directory');
    if (directory !== null && !isDirectory(directory)) return { status: 400, body: { error: 'directory must be an absolute path' } };
    return { status: 200, body: await agentCatalog(deps, directory, url.searchParams.get('refresh') === '1') };
  }
  if (url.pathname === '/agents/commands' && req.method === 'POST') {
    const body = (await deps.readJson(req)) as { entries?: unknown; directory?: unknown; wait?: unknown };
    const entries = Array.isArray(body.entries) ? body.entries : [];
    if (entries.length > 40 || !entries.every((entry) => isRunAssignee((entry as { assignee?: unknown })?.assignee) && ['preset', 'agent'].includes((entry as { kind?: unknown }).kind as string))) {
      return { status: 400, body: { error: 'entries must be at most 40 of { assignee, kind: preset | agent }' } };
    }
    if (body.directory !== undefined && body.directory !== null && !isDirectory(body.directory)) return { status: 400, body: { error: 'directory must be an absolute path' } };
    let commands: { id: string; name: string; changed: boolean }[];
    try {
      commands = deps.commands.ensure(entries as { assignee: RunAssignee; kind: 'preset' | 'agent' }[]);
    } catch (error) {
      return { status: 409, body: { error: `Could not write the agent command in ${deps.commands.dir}: ${error instanceof Error ? error.message : String(error)}` } };
    }
    const listed = body.wait === true && commands.length ? await deps.info.waitListed(commands.map((command) => command.name), (body.directory as string | undefined) ?? homedir()) : null;
    return { status: 200, body: { commands, listed, dir: deps.commands.dir } };
  }
  return null;
};
