// VS Code's own services, as the surface patches hand them to the frame
// (`src/patch.ts`): the instantiation service when the workbench starts, and
// the service identifiers by name. Only the members this extension uses are
// typed here, each in an interface named after VS Code's own (`IEditorService`
// is `EditorService`). Every one is a member of that VS Code interface, or a
// public member of a class VS Code's interfaces hand out (`EditorInput`,
// `URI`); `tests/vscode-api.test.ts` holds each to the pinned source, and the
// README lists what the frames use beyond them ("Which VS Code internals the
// frames use"). VS Code 1.140–1.144.

/** `IDisposable`. */
export interface Disposable {
  dispose(): void;
}
export type Event<T> = (listener: (value: T) => void) => Disposable;

/** Public members of VS Code's `URI` class. */
export interface Uri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
  toString(): string;
  toJSON(): unknown;
  with(change: Record<string, string>): Uri;
}

/** Public members of `EditorInput`, the abstract class `IEditorService` hands out for an open editor. */
export interface EditorInput {
  readonly typeId: string;
  readonly editorId?: string;
  readonly resource: Uri | undefined;
  getName(): string;
  isDirty(): boolean;
  toUntyped(options?: unknown): unknown;
  matches(other: unknown): boolean;
  /** The editor of the file at `target` instead (VS Code's move of an editor): `{ editor, options }`, or undefined. */
  rename(group: number, target: Uri): Promise<{ editor: unknown; options?: unknown } | undefined>;
}

/** `IEditorIdentifier`. */
export interface EditorIdentifier {
  readonly editor: EditorInput;
  readonly groupId: number;
}

export type OpenEditor = (editor: unknown, optionsOrGroup?: unknown, group?: unknown) => Promise<unknown>;
export type OpenEditors = (editors: unknown[], group?: unknown, options?: unknown) => Promise<unknown>;

/** `IEditorService`. */
export interface EditorService {
  readonly activeEditor: EditorInput | undefined;
  /** The editors on screen: the active one of each group. */
  readonly visibleEditors: readonly EditorInput[];
  /** 0: most recently active first, 1: in the order they appear. */
  getEditors(order: 0 | 1): readonly EditorIdentifier[];
  readonly onDidActiveEditorChange: Event<void>;
  readonly onDidEditorsChange: Event<unknown>;
  openEditor: OpenEditor;
  openEditors: OpenEditors;
  closeEditor(editor: EditorIdentifier, options?: unknown): Promise<void>;
  /** Puts these editors in place of those, where they are (`IUntypedEditorReplacement`). */
  replaceEditors(replacements: { editor: EditorInput; replacement: unknown }[], group: number): Promise<void>;
}

/** `IEditorGroup`. */
export interface EditorGroup {
  readonly id: number;
  readonly activeEditor: EditorInput | null;
  isSticky(editor: EditorInput): boolean;
  isPinned(editor: EditorInput): boolean;
  isActive(editor: EditorInput): boolean;
  getIndexOfEditor(editor: EditorInput): number;
}

/** `IEditorGroupsService` (these members are its base's, `IEditorGroupsContainer`). */
export interface EditorGroupsService {
  readonly whenRestored: Promise<void>;
  readonly activeGroup: EditorGroup;
  /** How many groups the editor area is split into. */
  readonly count: number;
  readonly onDidAddGroup: Event<EditorGroup>;
  readonly onDidRemoveGroup: Event<EditorGroup>;
  getGroup(id: number): EditorGroup | undefined;
}

export const PARTS = {
  editor: 'workbench.parts.editor',
  sidebar: 'workbench.parts.sidebar',
  panel: 'workbench.parts.panel',
  auxiliarybar: 'workbench.parts.auxiliarybar',
} as const;
export type Part = (typeof PARTS)[keyof typeof PARTS];

/** `IPartVisibilityChangeEvent`. */
export interface PartVisibilityEvent {
  readonly partId: string;
  readonly visible: boolean;
}

/** `IWorkbenchLayoutService`. */
export interface LayoutService {
  /** Once the parts are restored (restoring a view container shows its part again). */
  readonly whenRestored: Promise<void>;
  isVisible(part: Part): boolean;
  setPartHidden(hidden: boolean, part: Part): void;
  readonly onDidChangePartVisibility: Event<PartVisibilityEvent>;
  toggleMaximizedPanel(): void;
  isPanelMaximized(): boolean;
}

/** `ViewContainerLocation.Sidebar`. */
export const SIDEBAR = 0;

/** `IComposite`, the base of the pane composites (a view container shown). */
export interface PaneComposite {
  getId(): string;
}

/** `IPaneCompositePartService`. */
export interface PaneCompositePartService {
  readonly onDidPaneCompositeOpen: Event<{ composite: PaneComposite; viewContainerLocation: number }>;
  getActivePaneComposite(location: number): PaneComposite | undefined;
}

/** `IViewsService`. */
export interface ViewsService {
  openViewContainer(id: string, focus?: boolean): Promise<unknown>;
}

/** `IViewContainerModel`: a view container's views, and which of them it shows. */
export interface ViewContainerModel {
  /** Shows or hides one of its views, as its title's "Hide" does (kept in the workbench's storage). */
  setVisible(id: string, visible: boolean): void;
}

/** `IViewDescriptorService`. */
export interface ViewDescriptorService {
  getViewContainerByViewId(id: string): unknown;
  getViewContainerModel(viewContainer: unknown): ViewContainerModel;
}

/** `IQuickPickItem`. */
export interface QuickPickItem {
  label: string;
  description?: string;
}

/** `IQuickInputService`. */
export interface QuickInputService {
  /** VS Code's quick pick: the item chosen, or undefined when it was dismissed. */
  pick<T extends QuickPickItem>(items: readonly T[], options?: { title?: string; placeHolder?: string; activeItem?: T }): Promise<T | undefined>;
}

/** `IBadge`: what an activity shows (a count, an icon, progress); a count's number is its `NumberBadge`'s (README). */
export interface Badge {
  getDescription(): string;
}

/** `IActivity`. */
export interface Activity {
  readonly badge: Badge;
}

/** `IActivityService`: the badges VS Code's activity bar shows on its view containers. */
export interface ActivityService {
  readonly onDidChangeActivity: Event<unknown>;
  getViewContainerActivities(viewContainerId: string): Activity[];
}

/** `Severity.Info`. */
export const SEVERITY_INFO = 1;

/** `INotificationService`. */
export interface NotificationService {
  info(message: string): void;
  /** A notification with buttons (`IPromptChoice`: its `label` and `run` are its base's, which VS Code doesn't export). */
  prompt(severity: number, message: string, choices: { label: string; run(): void }[]): unknown;
}

/** `ConfigurationTarget.MEMORY`: above the user's settings, never written anywhere. */
export const MEMORY_TARGET = 8;

/** `IConfigurationValue`: a setting in each layer. */
export interface ConfigurationValue {
  readonly defaultValue?: unknown;
  readonly applicationValue?: unknown;
  readonly userValue?: unknown;
  readonly workspaceValue?: unknown;
  readonly workspaceFolderValue?: unknown;
  readonly memoryValue?: unknown;
}

/** `IConfigurationChangeEvent`. */
export interface ConfigurationChangeEvent {
  /** The `ConfigurationTarget` that changed. */
  readonly source: number;
  affectsConfiguration(key: string): boolean;
}

/** `IConfigurationService`. */
export interface ConfigurationService {
  /** In `target` (a `ConfigurationTarget`), or with overrides first (`{ resource }`: for that resource alone). */
  updateValue(key: string, value: unknown, targetOrOverrides: number | { resource?: Uri }, target?: number): Promise<void>;
  inspect(key: string): ConfigurationValue;
  readonly onDidChangeConfiguration: Event<ConfigurationChangeEvent>;
}

/** `IUserDataProfile`. */
export interface UserDataProfile {
  readonly isDefault: boolean;
  /** Its extensions' listing (`<extensions folder>/extensions.json` for the default profile). */
  readonly extensionsResource: Uri;
}

/** `IRemoteAgentEnvironment`. */
export interface RemoteAgentEnvironment {
  readonly profiles: { all: readonly UserDataProfile[] };
  /** The server's install (its `package.json` is always there). */
  readonly appRoot: Uri;
  /** Where extensions keep their global storage on the server. */
  readonly globalStorageHome: Uri;
}

/** `IRemoteAgentService`. */
export interface RemoteAgentService {
  getEnvironment(): Promise<RemoteAgentEnvironment | null>;
}

/** Public members of VS Code's `VSBuffer` class, in which `IFileService.readFile` hands out a file's content. */
export interface VsBuffer {
  readonly buffer: Uint8Array;
  readonly byteLength: number;
}

/** `IFileContent`. */
export interface FileContent {
  readonly value: VsBuffer;
}

/** `IFileService`. */
export interface FileService {
  /** Resolves once the scheme's provider is there (`vscode-remote` comes with the remote environment). */
  activateProvider(scheme: string): Promise<void>;
  hasProvider(resource: Uri): boolean;
  readFile(resource: Uri): Promise<FileContent>;
  /** Writes the file, its folders first. */
  writeFile(resource: Uri, buffer: VsBuffer): Promise<unknown>;
}

/** `ICommandEvent`: a command about to run, wherever from (a key, a menu, the command palette, an extension). */
export interface CommandEvent {
  readonly commandId: string;
  readonly args: unknown[];
}

/** `ICommandService`. */
export interface CommandService {
  readonly onWillExecuteCommand: Event<CommandEvent>;
  executeCommand(id: string, ...args: unknown[]): Promise<unknown>;
}

/** `IEnvironmentService`. */
export interface EnvironmentService {
  readonly userRoamingDataHome: Uri;
}

/** `IShellLaunchConfig`: how a terminal started. */
export interface ShellLaunchConfig {
  readonly name?: string;
  /** An extension's own pseudoterminal: its process is the extension's, not the server's pty host's. */
  readonly customPtyImplementation?: unknown;
  readonly hideFromUser?: boolean;
  readonly isFeatureTerminal?: boolean;
  readonly type?: string;
  readonly icon?: unknown;
  readonly color?: string;
}

/** `ITerminalInstance`. */
export interface TerminalInstance {
  readonly instanceId: number;
  /** Its process on the server's pty host, which another window can attach to. */
  readonly persistentProcessId: number | undefined;
  processId: number | undefined;
  readonly processReady: Promise<void>;
  readonly title: string;
  readonly titleSource: number;
  readonly shellLaunchConfig: ShellLaunchConfig;
  shellIntegrationNonce: string;
  readonly hasChildProcesses: boolean;
  getInitialCwd(): Promise<string>;
}

/** `ITerminalService`. */
export interface TerminalService {
  readonly instances: readonly TerminalInstance[];
  /** Done once VS Code has reconnected the workspace's terminals an earlier window left (persistent sessions). */
  readonly whenConnected: Promise<void>;
  readonly onDidCreateInstance: Event<TerminalInstance>;
  /** `ICreateTerminalOptions`: `{ config: IShellLaunchConfig }` (`attachPersistentProcess` attaches to a process). */
  createTerminal(options?: unknown): Promise<TerminalInstance>;
}

/** `ITerminalService`: the members that hide and show a terminal. */
export interface TerminalBackground {
  /** Shows a terminal that was hidden from the user (`hideFromUser`), as `terminal.show()` does. */
  showBackgroundTerminal(instance: TerminalInstance, suppressSetActive?: boolean): Promise<void>;
}

/** `ITerminalInstanceHost`, `ITerminalService`'s base. */
export interface TerminalInstanceHost {
  readonly activeInstance: TerminalInstance | undefined;
  readonly onDidChangeActiveInstance: Event<TerminalInstance | undefined>;
  setActiveInstance(instance: TerminalInstance): void;
  /** Reveals the instance, and focuses it. */
  focusInstance(instance: TerminalInstance): Promise<void>;
}

/** `ITerminalGroupService`. */
export interface TerminalGroupService {
  showPanel(focus?: boolean): Promise<void>;
}

/** Public members of `CommonTask`, the class of the tasks `ITaskService.run` takes. */
export interface Task {
  _label: string;
  /** Its source (`IBaseTaskSource`, which VS Code doesn't export): its `label` names it ("Workspace", "npm"). */
  _source: { readonly label: string };
  getDefinition(useSource?: boolean): Record<string, unknown> | undefined;
}

/** `ITaskService`. */
export interface TaskService {
  run(task: Task | undefined, options?: unknown, runSource?: number): Promise<unknown>;
}

/** `ILaunch`. */
export interface Launch {
  getCompound(name: string): unknown;
  /** A launch configuration by its name (`IConfig`), as VS Code starts one named. */
  getConfiguration(name: string): unknown;
}

/** `IDebugSessionOptions`: who started a session, and which of the window's debug UI it shows. */
export interface DebugSessionOptions {
  noDebug?: boolean;
  /** VS Code's own Start Debugging (F5, the Run and Debug view, its pickers): the user's launch, not an extension's. */
  startedByUser?: boolean;
  suppressDebugToolbar?: boolean;
  suppressDebugStatusbar?: boolean;
  suppressDebugView?: boolean;
}

/** `IAdapterManager`: the debuggers VS Code knows (their contributions). */
export interface AdapterManager {
  getDebugger(type: string): unknown;
}

/** `IUndoRedoService`: per resource (a file's URI), or per source. */
export interface UndoRedoService {
  canUndo(resource: Uri): boolean;
  undo(resource: Uri): Promise<void> | void;
  canRedo(resource: Uri): boolean;
  redo(resource: Uri): Promise<void> | void;
}

/** `ITextModel`. */
export interface TextModel {
  readonly uri: Uri;
  readonly onWillDispose: Event<void>;
  getValue(): string;
  setValue(value: string): void;
}

/** `IModelService`. */
export interface ModelService {
  readonly onModelAdded: Event<TextModel>;
}

/** `ITextModelService`: a reference keeps a model (`IReference`, disposed to let it go). */
export interface TextModelService {
  createModelReference(resource: Uri): Promise<Disposable>;
}

/** `IWorkingCopyIdentifier`. */
export interface WorkingCopyIdentifier {
  readonly resource: Uri;
}

/** `IWorkingCopy`. */
export interface WorkingCopy {
  isDirty(): boolean;
  /** `soft`: marked saved, its text kept (no save writes it), as VS Code does to a working copy it moves. */
  revert(options?: { soft?: boolean }): Promise<void>;
}

/** `ITextEditorModel`. */
export interface TextEditorModel {
  readonly textEditorModel: TextModel | null;
}

/** `ITextFileEditorModel`: these members are its bases'. */
export type TextFileEditorModel = WorkingCopyIdentifier & WorkingCopy & TextEditorModel;

/** `ITextFileEditorModelManager`. */
export interface TextFileEditorModelManager {
  readonly models: readonly TextFileEditorModel[];
  /** The file's model, resolved (`{ reload }`: read again from the file). */
  resolve(resource: Uri, options?: { reload?: { async: boolean } }): Promise<TextFileEditorModel>;
}

/** `ITextFileService`. */
export interface TextFileService {
  readonly files: TextFileEditorModelManager;
}

/** `IConfigurationManager`: the launch configuration chosen to start. */
export interface ConfigurationManager {
  readonly selectedConfiguration: { readonly launch: Launch | undefined; readonly name: string | undefined };
}

/** `IStackFrame`. */
export interface StackFrame {
  readonly frameId: number;
}

/** `IThread`. */
export interface DebugThread {
  getCallStack(): readonly StackFrame[];
}

/** `IDebugSession`. */
export interface DebugSession {
  getThread(threadId: number): DebugThread | undefined;
}

/** `IDebugModel`. */
export interface DebugModel {
  getSession(sessionId: string | undefined): DebugSession | undefined;
}

/** `IViewModel` (the debug view model: what is focused). */
export interface DebugViewModel {
  readonly focusedStackFrame: StackFrame | undefined;
}

/** `IDebugService`. */
export interface DebugService {
  getAdapterManager(): AdapterManager;
  getModel(): DebugModel;
  getViewModel(): DebugViewModel;
  /** Focuses a frame (the Debug Console evaluates in it), and opens its source. */
  focusStackFrame(frame: StackFrame | undefined, thread?: DebugThread, session?: DebugSession, options?: { explicit?: boolean; preserveFocus?: boolean }): Promise<void>;
  getConfigurationManager(): ConfigurationManager;
  startDebugging(launch: Launch | undefined, configOrName?: unknown, options?: DebugSessionOptions, saveBeforeStart?: boolean): Promise<boolean>;
}

/** Public members of `ExtensionIdentifier`, the class that names an extension in `IExtensionDescription`. */
export interface ExtensionIdentifier {
  readonly value: string;
}

/** `IExtensionDescription` (its members are `IRelaxedExtensionDescription`'s). */
export interface ExtensionDescription {
  identifier: ExtensionIdentifier;
}

/** `IExtensionService`. */
export interface ExtensionService {
  /** The extensions this window runs (installed and enabled). */
  readonly extensions: readonly ExtensionDescription[];
  whenInstalledExtensionsRegistered(): Promise<boolean>;
  readonly onDidChangeExtensions: Event<unknown>;
}

/** `WillSaveStateReason.SHUTDOWN`: the window is about to reload or close. */
export const SHUTDOWN = 1;

/** `StorageScope`: APPLICATION, PROFILE, WORKSPACE (APPLICATION_SHARED is the Sessions app's). */
export const STORAGE_SCOPES = [-1, 0, 1] as const;
/** `StorageScope.PROFILE`, `StorageTarget.MACHINE`. */
export const STORAGE_PROFILE = 0;
export const STORAGE_MACHINE = 1;

/** What `IStorageService.onDidChangeValue` asks for to keep its filtered event: a `DisposableStore`, of which it uses `add`. */
export interface DisposableStore {
  add<T extends Disposable>(disposable: T): T;
}

/** `IStorageService`. */
export interface StorageService {
  /**
   * Asks everyone for their latest state (`onWillSaveState`) and saves it to the storage's databases (IndexedDB);
   * VS Code reloads the window once a `SHUTDOWN` one resolves.
   */
  flush(reason?: number): Promise<void>;
  /** A value stored or removed in `scope` (any key when `key` is undefined). */
  onDidChangeValue(scope: number, key: string | undefined, disposable: DisposableStore): Event<unknown>;
  get(key: string, scope: number, fallbackValue?: string): string | undefined;
  store(key: string, value: string, scope: number, target: number): void;
  remove(key: string, scope: number): void;
}

/** `IWebview`. */
export interface Webview {
  /** The webview's content saved its state (`acquireVsCodeApi().setState`), which VS Code keeps with its editor or view. */
  readonly onDidUpdateState: Event<unknown>;
}

/** `IWebviewService`. */
export interface WebviewService {
  readonly webviews: Iterable<Webview>;
}

/** `ResultKind.NoMatchingKb`: VS Code binds nothing to the press. */
export const NO_MATCHING_KB = 0;

/** `IKeyboardEvent`, VS Code's own keyboard event: `keyCode` is VS Code's `KeyCode`. */
export interface VscodeKeyboardEvent {
  readonly _standardKeyboardEventBrand: true;
  readonly browserEvent: KeyboardEvent;
  readonly target: EventTarget | null;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly altGraphKey: boolean;
  readonly keyCode: number;
  readonly code: string;
  equals(keybinding: number): boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

/** `IKeybindingService`. */
export interface KeybindingService {
  /** What VS Code would run for the press where `target` is, without running it. */
  softDispatch(event: VscodeKeyboardEvent, target: EventTarget | null): { kind: number };
}

/** `ServicesAccessor`. */
export interface ServicesAccessor {
  get(id: unknown): unknown;
}

/** `IInstantiationService`. */
export interface InstantiationService {
  invokeFunction<R>(fn: (accessor: ServicesAccessor) => R): R;
}

export class VscodeServices {
  constructor(private readonly instantiation: InstantiationService, private readonly ids: Map<string, unknown>) {}

  get<T>(name: string): T {
    const id = this.ids.get(name);
    if (!id) throw new Error(`VS Code has no service ${name}`);
    return this.instantiation.invokeFunction((accessor) => accessor.get(id)) as T;
  }

  /** VS Code's URI class, for `URI.revive` and `URI.parse`: the class of a URI the environment service holds. */
  uriClass(): { revive(components: unknown): Uri; parse(text: string): Uri } {
    return this.get<EnvironmentService>('environmentService').userRoamingDataHome.constructor as unknown as { revive(components: unknown): Uri; parse(text: string): Uri };
  }

  /** VS Code's `VSBuffer` class, for `VSBuffer.wrap`: the class of a file's content the file service read (`sample`). */
  static bufferClass(sample: VsBuffer): { wrap(data: Uint8Array): VsBuffer } {
    return sample.constructor as unknown as { wrap(data: Uint8Array): VsBuffer };
  }
}

export const isEditorInput = (value: unknown): value is EditorInput => {
  const editor = value as EditorInput | null;
  return typeof editor === 'object' && editor !== null && typeof editor.typeId === 'string' && typeof editor.matches === 'function' && typeof editor.getName === 'function';
};
