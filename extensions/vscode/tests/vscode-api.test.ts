// Every member of VS Code's the frames declare (`workbench/vscode.ts`, `src/focus.ts`) is a member of the VS Code
// interface it is named after, or a public member of a class those interfaces hand out: never a protected, private or
// class-only one. The list below is reviewed; with the pinned VS Code source at hand (`vendors/vscode`, or
// VSCODE_SOURCE=<a checkout's root>) each entry is held to it.
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname;
const extension = join(here, '..');
const vscodeRoot = process.env.VSCODE_SOURCE ?? join(extension, '../../vendors/vscode');
const source = join(vscodeRoot, 'src/vs');
const havePinnedSource = existsSync(join(source, 'platform/storage/common/storage.ts'));

interface Reviewed {
  /** The VS Code interface (or class) that declares these members. */
  name: string;
  /** Its file under `src/vs`. */
  file: string;
  /** A class: allowed only for one VS Code's interfaces hand out, said here. */
  handedOutBy?: string;
}

/** Each declaration of ours, and VS Code's that declares its members. */
const REVIEWED: Record<string, Reviewed> = {
  Disposable: { name: 'IDisposable', file: 'base/common/lifecycle.ts' },
  Uri: { name: 'URI', file: 'base/common/uri.ts', handedOutBy: "every URI VS Code's interfaces take and give (IEditorService, IFileService, IEnvironmentService)" },
  EditorInput: { name: 'EditorInput', file: 'workbench/common/editor/editorInput.ts', handedOutBy: 'IEditorService.activeEditor, visibleEditors and getEditors, for each open editor' },
  EditorIdentifier: { name: 'IEditorIdentifier', file: 'workbench/common/editor.ts' },
  EditorService: { name: 'IEditorService', file: 'workbench/services/editor/common/editorService.ts' },
  EditorGroup: { name: 'IEditorGroup', file: 'workbench/services/editor/common/editorGroupsService.ts' },
  // IEditorGroupsService extends it.
  EditorGroupsService: { name: 'IEditorGroupsContainer', file: 'workbench/services/editor/common/editorGroupsService.ts' },
  PartVisibilityEvent: { name: 'IPartVisibilityChangeEvent', file: 'workbench/services/layout/browser/layoutService.ts' },
  LayoutService: { name: 'IWorkbenchLayoutService', file: 'workbench/services/layout/browser/layoutService.ts' },
  PaneComposite: { name: 'IComposite', file: 'workbench/common/composite.ts' },
  PaneCompositePartService: { name: 'IPaneCompositePartService', file: 'workbench/services/panecomposite/browser/panecomposite.ts' },
  ViewsService: { name: 'IViewsService', file: 'workbench/services/views/common/viewsService.ts' },
  // IQuickPickItem extends it.
  QuickPickItem: { name: 'IQuickItem', file: 'platform/quickinput/common/quickInput.ts' },
  QuickInputService: { name: 'IQuickInputService', file: 'platform/quickinput/common/quickInput.ts' },
  NotificationService: { name: 'INotificationService', file: 'platform/notification/common/notification.ts' },
  ConfigurationValue: { name: 'IConfigurationValue', file: 'platform/configuration/common/configuration.ts' },
  ConfigurationChangeEvent: { name: 'IConfigurationChangeEvent', file: 'platform/configuration/common/configuration.ts' },
  ConfigurationService: { name: 'IConfigurationService', file: 'platform/configuration/common/configuration.ts' },
  UserDataProfile: { name: 'IUserDataProfile', file: 'platform/userDataProfile/common/userDataProfile.ts' },
  RemoteAgentEnvironment: { name: 'IRemoteAgentEnvironment', file: 'platform/remote/common/remoteAgentEnvironment.ts' },
  RemoteAgentService: { name: 'IRemoteAgentService', file: 'workbench/services/remote/common/remoteAgentService.ts' },
  VsBuffer: { name: 'VSBuffer', file: 'base/common/buffer.ts', handedOutBy: "IFileService.readFile, which gives a file's content as one (IFileContent.value)" },
  FileContent: { name: 'IFileContent', file: 'platform/files/common/files.ts' },
  FileService: { name: 'IFileService', file: 'platform/files/common/files.ts' },
  CommandService: { name: 'ICommandService', file: 'platform/commands/common/commands.ts' },
  EnvironmentService: { name: 'IEnvironmentService', file: 'platform/environment/common/environment.ts' },
  ShellLaunchConfig: { name: 'IShellLaunchConfig', file: 'platform/terminal/common/terminal.ts' },
  TerminalInstance: { name: 'ITerminalInstance', file: 'workbench/contrib/terminal/browser/terminal.ts' },
  TerminalService: { name: 'ITerminalService', file: 'workbench/contrib/terminal/browser/terminal.ts' },
  TerminalInstanceHost: { name: 'ITerminalInstanceHost', file: 'workbench/contrib/terminal/browser/terminal.ts' },
  TerminalBackground: { name: 'ITerminalService', file: 'workbench/contrib/terminal/browser/terminal.ts' },
  TerminalGroupService: { name: 'ITerminalGroupService', file: 'workbench/contrib/terminal/browser/terminal.ts' },
  Task: { name: 'CommonTask', file: 'workbench/contrib/tasks/common/tasks.ts', handedOutBy: 'ITaskService.run, which takes the task to run' },
  TaskService: { name: 'ITaskService', file: 'workbench/contrib/tasks/common/taskService.ts' },
  Launch: { name: 'ILaunch', file: 'workbench/contrib/debug/common/debug.ts' },
  AdapterManager: { name: 'IAdapterManager', file: 'workbench/contrib/debug/common/debug.ts' },
  StackFrame: { name: 'IStackFrame', file: 'workbench/contrib/debug/common/debug.ts' },
  DebugThread: { name: 'IThread', file: 'workbench/contrib/debug/common/debug.ts' },
  DebugSession: { name: 'IDebugSession', file: 'workbench/contrib/debug/common/debug.ts' },
  DebugModel: { name: 'IDebugModel', file: 'workbench/contrib/debug/common/debug.ts' },
  DebugViewModel: { name: 'IViewModel', file: 'workbench/contrib/debug/common/debug.ts' },
  ConfigurationManager: { name: 'IConfigurationManager', file: 'workbench/contrib/debug/common/debug.ts' },
  ViewContainerModel: { name: 'IViewContainerModel', file: 'workbench/common/views.ts' },
  UndoRedoService: { name: 'IUndoRedoService', file: 'platform/undoRedo/common/undoRedo.ts' },
  TextModel: { name: 'ITextModel', file: 'editor/common/model.ts' },
  ModelService: { name: 'IModelService', file: 'editor/common/services/model.ts' },
  TextModelService: { name: 'ITextModelService', file: 'editor/common/services/resolverService.ts' },
  WorkingCopyIdentifier: { name: 'IWorkingCopyIdentifier', file: 'workbench/services/workingCopy/common/workingCopy.ts' },
  WorkingCopy: { name: 'IWorkingCopy', file: 'workbench/services/workingCopy/common/workingCopy.ts' },
  TextEditorModel: { name: 'ITextEditorModel', file: 'editor/common/services/resolverService.ts' },
  TextFileEditorModelManager: { name: 'ITextFileEditorModelManager', file: 'workbench/services/textfile/common/textfiles.ts' },
  TextFileService: { name: 'ITextFileService', file: 'workbench/services/textfile/common/textfiles.ts' },
  ViewDescriptorService: { name: 'IViewDescriptorService', file: 'workbench/common/views.ts' },
  DebugService: { name: 'IDebugService', file: 'workbench/contrib/debug/common/debug.ts' },
  ExtensionIdentifier: { name: 'ExtensionIdentifier', file: 'platform/extensions/common/extensions.ts', handedOutBy: 'IExtensionDescription.identifier, which names each extension IExtensionService runs' },
  // IExtensionDescription is Readonly<IRelaxedExtensionDescription>.
  ExtensionDescription: { name: 'IRelaxedExtensionDescription', file: 'platform/extensions/common/extensions.ts' },
  ExtensionService: { name: 'IExtensionService', file: 'workbench/services/extensions/common/extensions.ts' },
  DisposableStore: { name: 'DisposableStore', file: 'base/common/lifecycle.ts', handedOutBy: 'IStorageService.onDidChangeValue, which takes one to keep its event in' },
  StorageService: { name: 'IStorageService', file: 'platform/storage/common/storage.ts' },
  Webview: { name: 'IWebview', file: 'workbench/contrib/webview/browser/webview.ts' },
  WebviewService: { name: 'IWebviewService', file: 'workbench/contrib/webview/browser/webview.ts' },
  VscodeKeyboardEvent: { name: 'IKeyboardEvent', file: 'base/browser/keyboardEvent.ts' },
  KeybindingService: { name: 'IKeybindingService', file: 'platform/keybinding/common/keybinding.ts' },
  ServicesAccessor: { name: 'ServicesAccessor', file: 'platform/instantiation/common/instantiation.ts' },
  InstantiationService: { name: 'IInstantiationService', file: 'platform/instantiation/common/instantiation.ts' },
  // src/focus.ts
  WebviewMaker: { name: 'IWebviewService', file: 'workbench/contrib/webview/browser/webview.ts' },
};

/** Where the frames declare VS Code's members. */
const DECLARING = ['workbench/vscode.ts', 'src/focus.ts'];
/** Declarations there that aren't VS Code's (the frame's own stand-ins). */
const OWN = new Set(['FocusWindow', 'FocusGuard', 'GuardOptions']);

/**
 * TypeScript with comments, strings, template literals and regular expressions blanked (newlines kept), so the braces
 * left are the code's. Enough for VS Code's own sources and ours.
 */
const blanked = (text: string): string => {
  const out = text.split('');
  const blank = (from: number, to: number) => {
    for (let index = from; index < to; index++) if (out[index] !== '\n') out[index] = ' ';
  };
  const templates: number[] = [];
  let depth = 0;
  let previous = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char === '/' && next === '/') {
      const end = text.indexOf('\n', index);
      blank(index, end === -1 ? text.length : end);
      index = end === -1 ? text.length : end - 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      blank(index, end === -1 ? text.length : end + 2);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    const quote = char === "'" || char === '"' || char === '`' || (char === '}' && templates.length > 0 && templates[templates.length - 1] === depth);
    if (quote) {
      const isTemplate = char === '`' || char === '}';
      if (char === '}') templates.pop();
      const close = isTemplate ? '`' : char;
      let end = index + 1;
      for (; end < text.length; end++) {
        if (text[end] === '\\') {
          end++;
          continue;
        }
        if (text[end] === close) break;
        if (isTemplate && text[end] === '$' && text[end + 1] === '{') {
          templates.push(depth);
          end++;
          break;
        }
      }
      blank(index + 1, end);
      index = end;
      previous = 'x';
      continue;
    }
    if (char === '/' && /[(,=:[!&|?{};]|^$/.test(previous)) {
      // A regular expression: up to its unescaped closing slash, outside a class.
      let end = index + 1;
      let inClass = false;
      for (; end < text.length && text[end] !== '\n'; end++) {
        if (text[end] === '\\') {
          end++;
          continue;
        }
        if (text[end] === '[') inClass = true;
        else if (text[end] === ']') inClass = false;
        else if (text[end] === '/' && !inClass) break;
      }
      blank(index + 1, end);
      index = end;
      previous = 'x';
      continue;
    }
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (!/\s/.test(char)) previous = char;
  }
  return out.join('');
};

/** The members declared directly in `export interface NAME` (or class), with their modifiers; null when there is none. */
const membersOf = (text: string, kind: 'interface' | 'class', name: string): Map<string, string[]> | null => {
  const code = blanked(text);
  const start = new RegExp(`export\\s+(?:declare\\s+)?(?:abstract\\s+)?${kind}\\s+${name}\\b`).exec(code);
  if (!start) return null;
  const open = code.indexOf('{', start.index);
  let depth = 0;
  let end = open;
  for (; end < code.length; end++) {
    if (code[end] === '{') depth++;
    if (code[end] === '}' && --depth === 0) break;
  }
  const members = new Map<string, string[]>();
  depth = 0;
  let line = '';
  let lineDepth = 1;
  for (let index = open + 1; index <= end; index++) {
    const char = code[index]!;
    if (char === '\n' || index === end) {
      const match = /^\s*((?:(?:public|protected|private|static|readonly|abstract|override|declare|async|get|set)\s+)*)([#A-Za-z_$][\w$]*)\s*[?!]?\s*[:(<=;]/.exec(line);
      if (lineDepth === 0 && match) {
        const modifiers = match[1]!.trim().split(/\s+/).filter(Boolean);
        members.set(match[2]!, [...(members.get(match[2]!) ?? []), ...modifiers]);
      }
      line = '';
      lineDepth = depth;
      continue;
    }
    line += char;
    if (char === '{' || char === '(' || char === '[') depth++;
    if (char === '}' || char === ')' || char === ']') depth--;
  }
  return members;
};

/** Our declarations: each exported interface of the declaring files and its members. */
const ours = (): Map<string, string[]> => {
  const declared = new Map<string, string[]>();
  for (const file of DECLARING) {
    const text = readFileSync(join(extension, file), 'utf8');
    for (const match of text.matchAll(/export\s+interface\s+([A-Za-z_$][\w$]*)/g)) {
      const name = match[1]!;
      if (OWN.has(name)) continue;
      declared.set(name, [...(membersOf(text, 'interface', name)?.keys() ?? [])]);
    }
  }
  return declared;
};

const vscodeMembers = (reviewed: Reviewed) => {
  const text = readFileSync(join(source, reviewed.file), 'utf8');
  return membersOf(text, reviewed.handedOutBy ? 'class' : 'interface', reviewed.name);
};

describe("the VS Code members the frames use are its interfaces'", () => {
  test('each declaration of a VS Code member is on the reviewed list, a class only when an interface hands it out', () => {
    const declared = ours();
    expect([...declared.keys()].filter((name) => !(name in REVIEWED))).toEqual([]);
    expect(Object.keys(REVIEWED).filter((name) => !declared.has(name))).toEqual([]);
    for (const [name, members] of declared) expect(members.length > 0 ? name : `${name} declares nothing`).toBe(name);
  });

  test("no frame code reaches VS Code's protected save schedule or its implementation-only pending state", () => {
    const files = ['workbench', 'src', 'webview'].flatMap((dir) => readdirSync(join(extension, dir)).filter((file) => file.endsWith('.ts')).map((file) => join(dir, file)));
    const reaching = files.filter((file) => /shouldFlushWhenIdle|hasPendingUpdate/.test(readFileSync(join(extension, file), 'utf8')));
    expect(reaching).toEqual([]);
  });

  test.skipIf(!havePinnedSource)('each member is declared by that interface in the pinned VS Code source, or is public in the class an interface hands out', () => {
    const wrong: string[] = [];
    for (const [ourName, members] of ours()) {
      const reviewed = REVIEWED[ourName]!;
      const theirs = vscodeMembers(reviewed);
      if (!theirs) {
        wrong.push(`${ourName}: no ${reviewed.handedOutBy ? 'class' : 'interface'} ${reviewed.name} in ${reviewed.file}`);
        continue;
      }
      for (const member of members) {
        const modifiers = theirs.get(member);
        if (!modifiers) wrong.push(`${ourName}.${member}: not declared by ${reviewed.name}`);
        else if (modifiers.includes('protected') || modifiers.includes('private') || member.startsWith('#')) wrong.push(`${ourName}.${member}: ${modifiers.join(' ')} in ${reviewed.name}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test.skipIf(!havePinnedSource)('the check tells a protected or class-only member from an interface one (the storage hooks the frames no longer use)', () => {
    const storage = readFileSync(join(source, 'platform/storage/common/storage.ts'), 'utf8');
    const browserStorage = readFileSync(join(source, 'workbench/services/storage/browser/storageService.ts'), 'utf8');
    expect(membersOf(storage, 'class', 'AbstractStorageService')!.get('shouldFlushWhenIdle')).toContain('protected');
    expect(membersOf(browserStorage, 'class', 'BrowserStorageService')!.get('shouldFlushWhenIdle')).toContain('protected');
    expect(membersOf(storage, 'interface', 'IStorageService')!.has('shouldFlushWhenIdle')).toBe(false);
    expect(membersOf(storage, 'interface', 'IStorageService')!.has('hasPendingUpdate')).toBe(false);
    expect(membersOf(browserStorage, 'class', 'BrowserStorageService')!.has('hasPendingUpdate')).toBe(true);
    expect(membersOf(storage, 'interface', 'IStorageService')!.has('flush')).toBe(true);
  });
});
