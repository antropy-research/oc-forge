// The file editor: VS Code's editor (Monaco) in OpenChamber's Files view,
// coloring code with the grammars and themes of the compiled VS Code in
// vscode/. The host keeps the file; this page edits the text it hands over
// and hands the text back when the host saves.
import { connectHost, createFileSaveTracker, type HostReadyContext } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import * as monaco from 'monaco-editor/editor/editor.api.js';
// Monaco's editor features (find, folding, multi-cursor, …) without its own languages.
import 'virtual:monaco-features';
import { TextMateColors } from './textmate.ts';
import { languageFor, type VscodeIndex, type VscodeThemeFile } from '../src/vscodeData.ts';
import { toMonacoConfiguration } from '../src/monacoConfig.ts';
import { readSettings, vscodeFileUrl, type VscodeSettings } from '../src/settings.ts';

// Monaco's helper worker, from source bundled into this script: a sandboxed
// page cannot start a worker from a URL of its own.
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new Worker(URL.createObjectURL(new Blob([__WORKER_SOURCE__], { type: 'text/javascript' })), { name: 'editor' }),
};

const host = connectHost();
const container = document.getElementById('editor') as HTMLElement;
const status = document.getElementById('status') as HTMLElement;

const fetchJson = async <T>(path: string): Promise<T> => {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return (await response.json()) as T;
};

const readyOnce = new Promise<HostReadyContext>((resolve) => {
  host.onReady((context) => {
    applyHostReady(context, document.documentElement);
    resolve(context);
  });
});

const index = fetchJson<VscodeIndex>('vscode/index.json');
const wasm = async (): Promise<ArrayBuffer> => Uint8Array.from(atob(__ONIG_WASM__), (char) => char.charCodeAt(0)).buffer;
const colors = index.then((data) => new TextMateColors(data, fetchJson, wasm));

let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let cursorListener: monaco.IDisposable | null = null;
let tracker = createFileSaveTracker(null);
let settings: VscodeSettings = readSettings(undefined);

const showStatus = (parts: (string | HTMLElement)[]) => {
  status.replaceChildren(...parts.flatMap((part, at) => (at ? [Object.assign(document.createElement('span'), { className: 'sep', textContent: '·' }), part] : [part])));
};

const statusLink = (label: string, onClick: () => void): HTMLElement => {
  const button = document.createElement('button');
  button.className = 'link';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
};

/** The theme for OpenChamber's light or dark look, unless one was chosen in the VS Code panel. */
const themeId = (context: HostReadyContext): string => settings.theme ?? (context.theme.mode === 'light' ? 'light-modern' : 'dark-modern');

const version = (model: monaco.editor.ITextModel): string => String(model.getAlternativeVersionId());

const MINIMAP_MIN_WIDTH = 700;

const open = async (file: { path: string; name: string; readOnly: boolean; content: string }) => {
  const context = await readyOnce;
  const data = await index;
  const painter = await colors;
  settings = readSettings(await host.storage.get('settings').catch(() => undefined));
  const language = languageFor(data, file.name);
  const languageId = language?.id ?? 'plaintext';
  if (language && !monaco.languages.getLanguages().some((item) => item.id === language.id)) {
    monaco.languages.register({ id: language.id, aliases: language.aliases, extensions: language.extensions, filenames: language.filenames });
    if (language.configuration) {
      const raw = await fetchJson<unknown>(`vscode/languages/${language.id}.json`).catch(() => null);
      if (raw) monaco.languages.setLanguageConfiguration(language.id, toMonacoConfiguration(raw) as monaco.languages.LanguageConfiguration);
    }
  }
  const id = themeId(context);
  const themeEntry = data.themes.find((theme) => theme.id === id) ?? data.themes[0];
  if (themeEntry) {
    const theme = await fetchJson<VscodeThemeFile>(`vscode/themes/${themeEntry.id}.json`);
    const background = getComputedStyle(document.documentElement).getPropertyValue('--oc-bg').trim();
    await painter.useTheme(`vscode-${themeEntry.id}`, theme, settings.ownBackground ? null : /^#[0-9a-f]{6}$/i.test(background) ? background : null);
  }
  const colored = language?.scopeName ? await painter.colorLanguage(language.id, language.scopeName) : false;
  const model = monaco.editor.createModel(file.content, languageId, monaco.Uri.file(file.path || `/${file.name}`));
  editor?.getModel()?.dispose();
  if (!editor) {
    editor = monaco.editor.create(container, {
      model,
      automaticLayout: true,
      readOnly: file.readOnly,
      fontFamily: context.theme.tokens.mono || undefined,
      fontSize: 13,
      fontLigatures: false,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      stickyScroll: { enabled: true },
      wordWrap: settings.wordWrap ? 'on' : 'off',
      fixedOverflowWidgets: true,
      ariaLabel: `${file.name}, VS Code editor`,
    });
    // Cmd/Ctrl+S saves through the host, as in the Files view.
    editor.addAction({ id: 'oc.save', label: 'Save', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS], run: () => host.requestFileSave() });
    // The minimap only where there is room for it: in the narrow Files pane it would cover the text.
    const fit = () => editor?.updateOptions({ minimap: { enabled: settings.minimap && container.clientWidth >= MINIMAP_MIN_WIDTH } });
    new ResizeObserver(fit).observe(container);
    fit();
  } else {
    editor.setModel(model);
    editor.updateOptions({ readOnly: file.readOnly });
  }
  tracker = createFileSaveTracker(version(model));
  model.onDidChangeContent(() => host.reportFileChange(tracker.observe(version(model))));
  const renderStatus = () => {
    const position = editor?.getPosition();
    const parts: (string | HTMLElement)[] = [
      language ? language.aliases[0] ?? language.id : 'Plain text',
      position ? `Ln ${position.lineNumber}, Col ${position.column}` : '',
      colored ? `VS Code ${data.vscode.version} colors` : 'no VS Code grammar',
    ];
    if (file.readOnly) parts.push('read-only');
    const url = vscodeFileUrl(settings, file.path, { folder: context.directory, line: position?.lineNumber });
    if (url) parts.push(statusLink('Open in VS Code', () => void host.openUrl(url).catch((error) => host.toast({ kind: 'error', message: `Could not open VS Code: ${error instanceof Error ? error.message : String(error)}` }))));
    showStatus(parts.filter((part) => part !== ''));
  };
  renderStatus();
  cursorListener?.dispose();
  cursorListener = editor.onDidChangeCursorPosition(() => renderStatus());
};

host.onFileOpen((file) => {
  // A text editor is always handed text; a binary file stays with the host's view.
  if (file.encoding !== 'text') {
    host.reportFileUnsupported();
    return;
  }
  void open(file).catch((error) => {
    console.error('[vscode] could not open the file', error);
    host.reportFileUnsupported();
  });
});

host.onFileSnapshot(() => {
  const model = editor?.getModel();
  if (!model) throw new Error('No file is open');
  return { content: model.getValue(monaco.editor.EndOfLinePreference.LF), version: version(model) };
});

// Edits made while the host was writing stay unsaved.
host.onFileSaved((saved) => {
  host.reportFileChange({ dirty: tracker.markSaved(saved), edited: false });
});

