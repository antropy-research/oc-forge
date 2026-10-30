// VS Code's own services, as the surface patches hand them to the frame
// (`src/patch.ts`): the instantiation service when the workbench starts, and
// the service identifiers by name. Only the members this extension uses are
// typed here; each is a public member of a service interface of the
// workbench (VS Code 1.140–1.143).

export interface Disposable {
  dispose(): void;
}
export type Event<T> = (listener: (value: T) => void) => Disposable;

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

export interface EditorInput {
  readonly typeId: string;
  readonly editorId?: string;
  readonly resource: Uri | undefined;
  getName(): string;
  isDirty(): boolean;
  toUntyped(options?: unknown): unknown;
  matches(other: unknown): boolean;
  /** ExtensionsInput (`workbench.extensions.input2`). */
  readonly extension?: { identifier?: { id?: string } };
}

export interface EditorIdentifier {
  readonly editor: EditorInput;
  readonly groupId: number;
}

export type OpenEditor = (editor: unknown, optionsOrGroup?: unknown, group?: unknown) => Promise<unknown>;
export type OpenEditors = (editors: unknown[], group?: unknown, options?: unknown) => Promise<unknown>;

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

export interface EditorGroupsService {
  readonly whenRestored: Promise<void>;
  readonly activeGroup: { readonly id: number; readonly activeEditor: EditorInput | null };
  getGroup(id: number): { isSticky(editor: EditorInput): boolean } | undefined;
}

export const PARTS = {
  editor: 'workbench.parts.editor',
  sidebar: 'workbench.parts.sidebar',
  panel: 'workbench.parts.panel',
  auxiliarybar: 'workbench.parts.auxiliarybar',
} as const;
export type Part = (typeof PARTS)[keyof typeof PARTS];

export interface LayoutService {
  /** Once the parts are restored (restoring a view container shows its part again). */
  readonly whenRestored: Promise<void>;
  isVisible(part: Part): boolean;
  setPartHidden(hidden: boolean, part: Part): void;
  readonly onDidChangePartVisibility: Event<{ partId: string; visible: boolean }>;
  toggleMaximizedPanel(): void;
  isPanelMaximized(): boolean;
}

/** `ViewContainerLocation.Sidebar`. */
export const SIDEBAR = 0;

export interface PaneCompositePartService {
  readonly onDidPaneCompositeOpen: Event<{ composite: { getId(): string }; viewContainerLocation: number }>;
  getActivePaneComposite(location: number): { getId(): string } | undefined;
}

export interface ViewsService {
  openViewContainer(id: string, focus?: boolean): Promise<unknown>;
}

export interface QuickPickItem {
  label: string;
  description?: string;
}

export interface QuickInputService {
  /** VS Code's quick pick: the item chosen, or undefined when it was dismissed. */
  pick<T extends QuickPickItem>(items: readonly T[], options?: { title?: string; placeHolder?: string; activeItem?: T }): Promise<T | undefined>;
}

/** `ConfigurationTarget.MEMORY`: above the user's settings, never written anywhere. */
export const MEMORY_TARGET = 8;

export interface ConfigurationService {
  updateValue(key: string, value: unknown, target: number): Promise<void>;
  /** A setting's value in each layer (`IConfigurationValue`). */
  inspect(key: string): { defaultValue?: unknown; applicationValue?: unknown; userValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown; memoryValue?: unknown };
  /** `source`: the `ConfigurationTarget` that changed. */
  readonly onDidChangeConfiguration: Event<{ readonly source: number; affectsConfiguration(key: string): boolean }>;
}

export interface RemoteAgentService {
  /** The server's profiles: the default one lists the installed extensions in `<extensions folder>/extensions.json`. */
  getEnvironment(): Promise<{ profiles?: { all?: { isDefault?: boolean; extensionsResource?: Uri }[] } } | null>;
}

export interface FileService {
  /** Resolves once the scheme's provider is there (`vscode-remote` comes with the remote environment). */
  activateProvider(scheme: string): Promise<void>;
  hasProvider(resource: Uri): boolean;
}

export interface CommandService {
  executeCommand(id: string, ...args: unknown[]): Promise<unknown>;
}

export interface EnvironmentService {
  readonly userRoamingDataHome: Uri;
}

export interface TerminalService {
  readonly instances: readonly unknown[];
  /** Done once VS Code has reconnected the workspace's terminals an earlier window left (persistent sessions). */
  readonly whenConnected: Promise<void>;
}

/** `WillSaveStateReason.SHUTDOWN`: the window is about to reload or close. */
export const SHUTDOWN = 1;

export interface StorageService {
  /** Saves VS Code's state to its databases (IndexedDB); VS Code reloads the window once this resolves. */
  flush(reason?: number): Promise<void>;
  /** Whether its save every few seconds runs now: on the web, only while the document has focus. */
  shouldFlushWhenIdle?: () => boolean;
  readonly hasPendingUpdate?: boolean;
}

/** `ResultKind.NoMatchingKb`: VS Code binds nothing to the press. */
export const NO_MATCHING_KB = 0;

/** VS Code's own keyboard event (`IKeyboardEvent`): `keyCode` is VS Code's `KeyCode`. */
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

export interface KeybindingService {
  /** What VS Code would run for the press where `target` is, without running it. */
  softDispatch(event: VscodeKeyboardEvent, target: EventTarget | null): { kind: number };
}

type Accessor = { get(id: unknown): unknown };
export type InstantiationService = { invokeFunction<R>(fn: (accessor: Accessor) => R): R };

export class VscodeServices {
  constructor(private readonly instantiation: InstantiationService, private readonly ids: Map<string, unknown>) {}

  get<T>(name: string): T {
    const id = this.ids.get(name);
    if (!id) throw new Error(`VS Code has no service ${name}`);
    return this.instantiation.invokeFunction((accessor) => accessor.get(id)) as T;
  }

  /** VS Code's URI class, for `URI.revive`. */
  uriClass(): { revive(components: unknown): Uri; parse(text: string): Uri } {
    return this.get<EnvironmentService>('environmentService').userRoamingDataHome.constructor as unknown as { revive(components: unknown): Uri; parse(text: string): Uri };
  }
}

export const isEditorInput = (value: unknown): value is EditorInput => {
  const editor = value as EditorInput | null;
  return typeof editor === 'object' && editor !== null && typeof editor.typeId === 'string' && typeof editor.matches === 'function' && typeof editor.getName === 'function';
};
