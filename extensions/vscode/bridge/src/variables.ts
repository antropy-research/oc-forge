// VS Code's variables in a launch configuration that the runtime can't resolve: those that name the active editor
// (the runtime has none), and those that ask the user (`${input:…}`, `${command:…}`), which ask where the user is.
// The page or the rail resolves them before the configuration goes to the runtime; the runtime resolves the rest
// (`${workspaceFolder}`, `${env:…}`, `${config:…}`) as VS Code does.

const NAME = /\$\{([A-Za-z][\w]*(?::[^}]+)?)\}/g;

/** Every `${…}` variable a configuration names. */
export const variablesIn = (value: unknown, into = new Set<string>()): Set<string> => {
  if (typeof value === 'string') {
    for (const match of value.matchAll(NAME)) into.add(match[1]!);
  } else if (Array.isArray(value)) {
    for (const item of value) variablesIn(item, into);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) variablesIn(item, into);
  }
  return into;
};

/** The configuration with the variables `values` has replaced; the others stay. */
export const replaceVariables = <T>(value: T, values: ReadonlyMap<string, string>): T => {
  if (typeof value === 'string') return value.replace(NAME, (all, name: string) => values.get(name) ?? all) as T;
  if (Array.isArray(value)) return value.map((item) => replaceVariables(item, values)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceVariables(item, values)])) as T;
  return value;
};

export const EDITOR_VARIABLES = new Set([
  'file', 'fileBasename', 'fileBasenameNoExtension', 'fileDirname', 'fileExtname', 'relativeFile', 'relativeFileDirname',
  'lineNumber', 'columnNumber', 'selectedText', 'fileWorkspaceFolder', 'fileWorkspaceFolderBasename', 'fileDirnameBasename',
]);

/** Whether resolving needs the user's editor or the user (`input:`, `command:`). */
export const needsFront = (names: Iterable<string>): { editor: boolean; ask: boolean } => {
  let editor = false;
  let ask = false;
  for (const name of names) {
    if (EDITOR_VARIABLES.has(name)) editor = true;
    if (name.startsWith('input:') || name.startsWith('command:')) ask = true;
  }
  return { editor, ask };
};

export interface ActiveEditor {
  /** The file's path on the server. */
  file: string;
  /** Its workspace folder's path, if in one. */
  folder?: string;
  line: number;
  column: number;
  selectedText: string;
}

const dirname = (file: string): string => (file.lastIndexOf('/') > 0 ? file.slice(0, file.lastIndexOf('/')) : '/');
const basename = (file: string): string => file.slice(file.lastIndexOf('/') + 1);
const extname = (file: string): string => {
  const base = basename(file);
  return base.lastIndexOf('.') > 0 ? base.slice(base.lastIndexOf('.')) : '';
};

/** The editor variables' values for an editor (paths with `/`). */
export const editorValues = (editor: ActiveEditor): Map<string, string> => {
  const relative = editor.folder && editor.file.startsWith(`${editor.folder}/`) ? editor.file.slice(editor.folder.length + 1) : editor.file;
  const values = new Map<string, string>([
    ['file', editor.file],
    ['fileBasename', basename(editor.file)],
    ['fileBasenameNoExtension', basename(editor.file).slice(0, basename(editor.file).length - extname(editor.file).length)],
    ['fileDirname', dirname(editor.file)],
    ['fileExtname', extname(editor.file)],
    ['relativeFile', relative],
    ['relativeFileDirname', relative.includes('/') ? dirname(relative) : '.'],
    ['lineNumber', String(editor.line)],
    ['columnNumber', String(editor.column)],
    ['selectedText', editor.selectedText],
    ['fileDirnameBasename', basename(dirname(editor.file))],
  ]);
  if (editor.folder) {
    values.set('fileWorkspaceFolder', editor.folder);
    values.set('fileWorkspaceFolderBasename', basename(editor.folder));
  }
  return values;
};

export interface InputDefinition {
  id: string;
  type: 'promptString' | 'pickString' | 'command';
  description?: string;
  default?: string;
  password?: boolean;
  options?: (string | { label?: string; value: string })[];
  command?: string;
  args?: unknown;
}

export interface Asker {
  /** The user's text, or undefined if they cancelled. */
  prompt(input: InputDefinition): PromiseLike<string | undefined>;
  pick(input: InputDefinition): PromiseLike<string | undefined>;
  /** A command's answer (`${command:…}` and command inputs). */
  command(id: string, args: unknown): PromiseLike<unknown>;
}

/**
 * Resolves the variables that ask (`input:`, `command:`), each once, in order: their values, or null if the user
 * cancelled one. `commandAliases` maps a debugger's variable names (its `variables` contribution, such as
 * `PickProcess`) to the commands they run.
 */
export const askVariables = async (
  names: Iterable<string>,
  inputs: readonly InputDefinition[],
  asker: Asker,
  config: unknown,
  commandAliases: Readonly<Record<string, string>> = {},
): Promise<Map<string, string> | null> => {
  const values = new Map<string, string>();
  for (const name of names) {
    if (values.has(name)) continue;
    if (name.startsWith('input:')) {
      const input = inputs.find((item) => item.id === name.slice('input:'.length));
      if (!input) throw new Error(`Undefined input variable '${name.slice('input:'.length)}'`);
      const answer = input.type === 'pickString' ? await asker.pick(input)
        : input.type === 'command' ? await Promise.resolve(asker.command(input.command ?? '', input.args)).then((value) => (value === undefined || value === null ? undefined : String(value)))
          : await asker.prompt(input);
      if (answer === undefined) return null;
      values.set(name, answer);
    } else if (name.startsWith('command:')) {
      const id = name.slice('command:'.length);
      const answer = await asker.command(commandAliases[id] ?? id, config);
      if (answer === undefined || answer === null) return null;
      values.set(name, String(answer));
    }
  }
  return values;
};
