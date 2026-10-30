// The Explorer's Outline and Timeline in the rail, which follow an active editor the rail never has: the page's.
// The page tells its window's rail which editor is active, its symbols (the language's own document symbol provider,
// `vscode.executeDocumentSymbolProvider`) and its cursor; the rail shows them, and a choice there reveals the symbol
// in the page. The Timeline is the file's Git history (the Git extension's API); VS Code's local history has no API.
// They stand in for VS Code's own Outline and Timeline in the rail, which it hides.
import * as vscode from 'vscode';
import type { Bus } from './bus.ts';
import { FRAME, type BridgePart } from './protocol.ts';
import { SYMBOL_ICONS, symbolPath, type WireRange, type WireSymbol } from './wire.ts';

interface ActiveState {
  uri: string | null;
  symbols: WireSymbol[];
  /** Whether the language gave symbols (else the Outline says it can't). */
  provides: boolean;
}

const wireRange = (range: vscode.Range): WireRange => [range.start.line, range.start.character, range.end.line, range.end.character];
const toRange = ([sl, sc, el, ec]: WireRange): vscode.Range => new vscode.Range(sl, sc, el, ec);

const fromDocumentSymbols = (symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[]): WireSymbol[] => {
  const nested = symbols.filter((symbol): symbol is vscode.DocumentSymbol => 'children' in symbol);
  if (nested.length === symbols.length) {
    const convert = (symbol: vscode.DocumentSymbol): WireSymbol => ({
      name: symbol.name, detail: symbol.detail, kind: symbol.kind, range: wireRange(symbol.range), selectionRange: wireRange(symbol.selectionRange),
      children: [...symbol.children].sort((a, b) => a.range.start.compareTo(b.range.start)).map(convert),
    });
    return [...nested].sort((a, b) => a.range.start.compareTo(b.range.start)).map(convert);
  }
  // Flat symbol information: nested by their ranges.
  const flat = (symbols as vscode.SymbolInformation[]).map((symbol): WireSymbol => ({
    name: symbol.name, detail: symbol.containerName, kind: symbol.kind, range: wireRange(symbol.location.range), selectionRange: wireRange(symbol.location.range), children: [],
  })).sort((a, b) => a.range[0] - b.range[0] || a.range[1] - b.range[1]);
  const roots: WireSymbol[] = [];
  const stack: WireSymbol[] = [];
  for (const symbol of flat) {
    while (stack.length && !(symbol.range[0] >= stack.at(-1)!.range[0] && symbol.range[2] <= stack.at(-1)!.range[2])) stack.pop();
    (stack.length ? stack.at(-1)!.children : roots).push(symbol);
    stack.push(symbol);
  }
  return roots;
};

export const startViews = (bus: Bus, context: vscode.ExtensionContext, part: BridgePart, log: (line: string) => void): void => {
  if (part === 'editor') startPageSide(bus, context, log);
  if (part === 'view') startRailSide(bus, context, log);
};

const startPageSide = (bus: Bus, context: vscode.ExtensionContext, log: (line: string) => void): void => {
  let state: ActiveState = { uri: null, symbols: [], provides: false };
  let version = 0;
  const publish = async (): Promise<void> => {
    const mine = ++version;
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      state = { uri: null, symbols: [], provides: false };
    } else {
      const symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>('vscode.executeDocumentSymbolProvider', editor.document.uri).then((value) => value, () => undefined);
      if (mine !== version) return;
      state = { uri: editor.document.uri.toString(), symbols: symbols ? fromDocumentSymbols(symbols) : [], provides: Boolean(symbols) };
    }
    bus.send({ type: 'editor.active', to: 'view', ...state });
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const soon = (ms: number): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void publish().catch((error) => log(`outline: ${error}`));
    }, ms);
  };
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => soon(50)));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document === vscode.window.activeTextEditor?.document) soon(400);
  }));
  // A language whose symbols come once its extension started: once more a little later.
  context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(() => {
    if (!state.provides && vscode.window.activeTextEditor) soon(800);
  }));
  let cursorTimer: ReturnType<typeof setTimeout> | null = null;
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection((event) => {
    if (event.textEditor !== vscode.window.activeTextEditor) return;
    if (cursorTimer) clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => {
      const position = event.textEditor.selection.active;
      bus.send({ type: 'editor.cursor', to: 'view', uri: event.textEditor.document.uri.toString(), line: position.line, character: position.character });
    }, 100);
  }));
  bus.on('editor.current', () => state);
  bus.on('editor.reveal', async (message) => {
    await vscode.commands.executeCommand(FRAME.allowFocus).then(undefined, () => undefined);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(String(message.uri)));
    const selection = toRange(message.range as WireRange);
    await vscode.window.showTextDocument(document, { selection: new vscode.Range(selection.start, selection.start), preserveFocus: message.preserveFocus === true });
    return true;
  });
  context.subscriptions.push({ dispose: bus.onMembers(() => soon(50)).dispose });
  soon(0);
};

class OutlineProvider implements vscode.TreeDataProvider<WireSymbol> {
  state: ActiveState = { uri: null, symbols: [], provides: false };
  private readonly parents = new Map<WireSymbol, WireSymbol | undefined>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  set(state: ActiveState): void {
    this.state = state;
    this.parents.clear();
    const walk = (symbols: WireSymbol[], parent?: WireSymbol): void => {
      for (const symbol of symbols) {
        this.parents.set(symbol, parent);
        walk(symbol.children, symbol);
      }
    };
    walk(state.symbols);
    this.changed.fire();
  }

  getTreeItem(symbol: WireSymbol): vscode.TreeItem {
    const item = new vscode.TreeItem(symbol.name, symbol.children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    item.description = symbol.detail || undefined;
    item.iconPath = new vscode.ThemeIcon(`symbol-${SYMBOL_ICONS[symbol.kind] ?? 'misc'}`);
    item.command = { command: 'openchamber.bridge.revealSymbol', title: 'Reveal', arguments: [this.state.uri, symbol.selectionRange] };
    item.id = `${symbol.range.join(',')}|${symbol.name}`;
    return item;
  }

  getChildren(symbol?: WireSymbol): WireSymbol[] {
    return symbol ? symbol.children : this.state.symbols;
  }

  getParent(symbol: WireSymbol): WireSymbol | undefined {
    return this.parents.get(symbol);
  }
}

interface Commit {
  hash: string;
  message: string;
  parents: string[];
  authorName?: string;
  authorDate?: Date;
}

interface GitApi {
  getRepository(uri: vscode.Uri): { log(options: { path?: string; maxEntries?: number }): Promise<Commit[]> } | null;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

class TimelineProvider implements vscode.TreeDataProvider<Commit> {
  uri: vscode.Uri | null = null;
  commits: Commit[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly git: () => Promise<GitApi | null>) {}

  async load(uri: vscode.Uri | null): Promise<void> {
    this.uri = uri;
    this.commits = [];
    if (uri) {
      const git = await this.git();
      const repository = git?.getRepository(uri);
      this.commits = repository ? await repository.log({ path: uri.fsPath, maxEntries: 50 }).catch(() => []) : [];
    }
    if (this.uri === uri) this.changed.fire();
  }

  getTreeItem(commit: Commit): vscode.TreeItem {
    const item = new vscode.TreeItem(commit.message.split('\n')[0] ?? commit.hash.slice(0, 7), vscode.TreeItemCollapsibleState.None);
    item.description = [commit.authorName, commit.authorDate ? relative(commit.authorDate) : undefined].filter(Boolean).join(', ');
    item.tooltip = `${commit.hash.slice(0, 8)} ${commit.authorName ?? ''}\n\n${commit.message}`;
    item.iconPath = new vscode.ThemeIcon('git-commit');
    if (this.uri) item.command = { command: 'openchamber.bridge.openCommit', title: 'Open Changes', arguments: [this.uri.toString(), commit.hash, commit.parents[0] ?? null] };
    return item;
  }

  getChildren(commit?: Commit): Commit[] {
    return commit ? [] : this.commits;
  }
}

const relative = (date: Date): string => {
  const minutes = Math.round((Date.now() - new Date(date).getTime()) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 0)} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} hr ago`;
  return `${Math.round(minutes / 60 / 24)} days ago`;
};

const startRailSide = (bus: Bus, context: vscode.ExtensionContext, log: (line: string) => void): void => {
  const outline = new OutlineProvider();
  const outlineView = vscode.window.createTreeView('openchamber.outline', { treeDataProvider: outline, showCollapseAll: true });
  const gitApi = async (): Promise<GitApi | null> => {
    const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
    if (!extension) return null;
    const exports = extension.isActive ? extension.exports : await extension.activate();
    return exports?.getAPI(1) ?? null;
  };
  const timeline = new TimelineProvider(gitApi);
  const timelineView = vscode.window.createTreeView('openchamber.timeline', { treeDataProvider: timeline });
  context.subscriptions.push(outlineView, timelineView);
  const NO_EDITOR = "The page's active editor cannot provide outline information.";
  const apply = (state: ActiveState): void => {
    outline.set(state);
    outlineView.message = !state.uri ? 'There is no editor open in the page.' : state.provides ? undefined : NO_EDITOR;
    const uri = state.uri ? vscode.Uri.parse(state.uri) : null;
    if (uri?.toString() !== timeline.uri?.toString()) void timeline.load(uri).then(() => {
      timelineView.message = !uri ? 'There is no editor open in the page.' : timeline.commits.length ? undefined : 'The page\'s active file has no Git history.';
    });
  };
  bus.on('editor.active', (message) => apply({ uri: (message.uri as string | null) ?? null, symbols: (message.symbols as WireSymbol[]) ?? [], provides: Boolean(message.provides) }));
  bus.on('editor.cursor', async (message) => {
    if (message.uri !== outline.state.uri || !outlineView.visible) return;
    const path = symbolPath(outline.state.symbols, Number(message.line), Number(message.character));
    const target = path.at(-1);
    if (target) await Promise.resolve(outlineView.reveal(target, { select: true, focus: false, expand: true })).then(undefined, () => undefined);
  });
  context.subscriptions.push(vscode.commands.registerCommand('openchamber.bridge.revealSymbol', async (uri: string, range: WireRange) => {
    if (uri) await bus.request('editor', 'editor.reveal', { uri, range }, 10_000).catch((error) => log(`reveal: ${error}`));
  }));
  context.subscriptions.push(vscode.commands.registerCommand('openchamber.bridge.openCommit', async (uri: string, hash: string, parent: string | null) => {
    const git = await gitApi();
    if (!git) return;
    const file = vscode.Uri.parse(uri);
    const name = file.path.slice(file.path.lastIndexOf('/') + 1);
    // VS Code's own diff of the commit's change to the file, which the rail hands to the page.
    await vscode.commands.executeCommand('vscode.diff', git.toGitUri(file, parent ?? `${hash}~`), git.toGitUri(file, hash), `${name} (${hash.slice(0, 7)})`);
  }));
  // VS Code's own Outline and Timeline follow the rail's active editor, which it has none of: ours stand in for them.
  const hideNative = (): void => {
    for (const id of ['outline', 'timeline']) void vscode.commands.executeCommand(`${id}.removeView`).then(undefined, () => undefined);
  };
  context.subscriptions.push(outlineView.onDidChangeVisibility((event) => {
    if (event.visible) hideNative();
  }));
  if (outlineView.visible) hideNative();
  const ask = async (): Promise<void> => {
    if (!bus.has('editor')) {
      apply({ uri: null, symbols: [], provides: false });
      return;
    }
    const state = await bus.request<ActiveState>('editor', 'editor.current', {}, 5_000).catch(() => null);
    if (state) apply(state);
  };
  context.subscriptions.push({ dispose: bus.onMembers(() => void ask()).dispose });
  void ask();
};
