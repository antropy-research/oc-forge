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
}

/** `IEditorGroup`. */
export interface EditorGroup {
  readonly id: number;
  readonly activeEditor: EditorInput | null;
  isSticky(editor: EditorInput): boolean;
}

/** `IEditorGroupsService` (these members are its base's, `IEditorGroupsContainer`). */
export interface EditorGroupsService {
  readonly whenRestored: Promise<void>;
  readonly activeGroup: EditorGroup;
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

/** `INotificationService`. */
export interface NotificationService {
  info(message: string): void;
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
  updateValue(key: string, value: unknown, target: number): Promise<void>;
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
}

/** `IRemoteAgentService`. */
export interface RemoteAgentService {
  getEnvironment(): Promise<RemoteAgentEnvironment | null>;
}

/** `IFileService`. */
export interface FileService {
  /** Resolves once the scheme's provider is there (`vscode-remote` comes with the remote environment). */
  activateProvider(scheme: string): Promise<void>;
  hasProvider(resource: Uri): boolean;
}

/** `ICommandService`. */
export interface CommandService {
  executeCommand(id: string, ...args: unknown[]): Promise<unknown>;
}

/** `IEnvironmentService`. */
export interface EnvironmentService {
  readonly userRoamingDataHome: Uri;
}

/** `ITerminalService`. */
export interface TerminalService {
  readonly instances: readonly unknown[];
  /** Done once VS Code has reconnected the workspace's terminals an earlier window left (persistent sessions). */
  readonly whenConnected: Promise<void>;
}

/** `WillSaveStateReason.SHUTDOWN`: the window is about to reload or close. */
export const SHUTDOWN = 1;

/** `StorageScope`: APPLICATION, PROFILE, WORKSPACE (APPLICATION_SHARED is the Sessions app's). */
export const STORAGE_SCOPES = [-1, 0, 1] as const;

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
}

export const isEditorInput = (value: unknown): value is EditorInput => {
  const editor = value as EditorInput | null;
  return typeof editor === 'object' && editor !== null && typeof editor.typeId === 'string' && typeof editor.matches === 'function' && typeof editor.getName === 'function';
};
