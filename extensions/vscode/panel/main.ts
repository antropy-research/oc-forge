// The VS Code panel: where the VS Code Server answers, a way to open the
// folder at hand in it (in OpenChamber's built-in browser on desktop, or a
// browser tab), and how VS Code's editor in the Files view looks. The same
// page, loaded as the background frame, answers the "Open in VS Code" chat action.
import { connectHost, type GuestActionItem, type JsonValue } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { allPatterns } from '../src/fileTypes.ts';
import { DEFAULT_SETTINGS, parseServerUrl, readSettings, vscodeFolderUrl, withoutToken, type VscodeSettings } from '../src/settings.ts';

const host = connectHost();
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const loadSettings = async (): Promise<VscodeSettings> => readSettings(await host.storage.get('settings').catch(() => undefined));

const openInVscode = async (folder: string | null): Promise<void> => {
  const url = vscodeFolderUrl(await loadSettings(), folder);
  if (!url) {
    await host.toast({ kind: 'info', message: 'Set where the VS Code Server answers in the VS Code panel first.' });
    return;
  }
  try {
    await host.openUrl(url);
  } catch (error) {
    await host.toast({ kind: 'error', message: `Could not open VS Code (${messageOf(error)}). Its address is copied instead.`, copy: { text: url } });
    await host.writeClipboard(url).catch(() => {});
  }
};

// "Open in VS Code" on a chat: its folder (or worktree), in VS Code.
host.onAction(async (item: GuestActionItem) => {
  if (item.kind === 'session' && item.action === 'open-in-vscode') await openInVscode(item.directory);
});

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string | null)[]): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  const { class: className, ...rest } = props;
  if (className) node.className = className;
  Object.assign(node, rest);
  for (const child of children) if (child !== null) node.append(child);
  return node;
};

const THEME_CHOICES: [string, string][] = [
  ['', "Follow OpenChamber's light or dark look"],
  ['dark-modern', 'Dark Modern'],
  ['light-modern', 'Light Modern'],
  ['dark-plus', 'Dark+'],
  ['light-plus', 'Light+'],
];

/** What the panel shows: the settings as stored and the folder OpenChamber has open. */
const view: { settings: VscodeSettings; directory: string | null } = { settings: { ...DEFAULT_SETTINGS }, directory: null };

const render = (root: HTMLElement): void => {
  const { settings, directory } = view;
  const save = async (patch: Partial<VscodeSettings>) => {
    const next = { ...view.settings, ...patch };
    await host.storage.set('settings', next as unknown as JsonValue);
    view.settings = next;
    render(root);
  };

  const url = el('input', { type: 'url', value: settings.serverUrl ?? '', placeholder: 'http://100.116.120.66:35311', autocomplete: 'off' });
  url.setAttribute('aria-label', 'VS Code Server address');
  const token = el('input', { type: 'password', value: settings.token ?? '', placeholder: 'connection token', autocomplete: 'off' });
  token.setAttribute('aria-label', 'VS Code Server connection token');
  const problem = el('p', { class: 'problem', role: 'alert' });
  const saveServer = el('button', { type: 'button', textContent: 'Save' });
  saveServer.addEventListener('click', () => {
    const address = url.value.trim() ? parseServerUrl(url.value) : null;
    if (url.value.trim() && !address) {
      problem.textContent = 'That is not an http(s) address of a server, like http://host:35311.';
      return;
    }
    if (token.value.trim() && !/^[A-Za-z0-9._~-]{1,256}$/.test(token.value.trim())) {
      problem.textContent = 'A connection token is letters, digits and . _ ~ - only.';
      return;
    }
    void save({ serverUrl: address, token: token.value.trim() || null });
  });

  const folderUrl = vscodeFolderUrl(settings, directory);
  const openFolder = el('button', { type: 'button', textContent: directory ? 'Open this folder in VS Code' : 'Open VS Code', disabled: !folderUrl });
  openFolder.addEventListener('click', () => void openInVscode(directory));
  const copy = el('button', { type: 'button', textContent: 'Copy the link', disabled: !folderUrl });
  copy.addEventListener('click', () => {
    if (folderUrl) void host.writeClipboard(folderUrl).then(() => host.toast({ kind: 'success', message: 'Copied the VS Code link' }));
  });
  const browser = el('button', { type: 'button', textContent: 'Show the browser panel' });
  browser.addEventListener('click', () => void host.openSurface('browser').catch((error) => host.toast({ kind: 'error', message: `The browser panel did not open: ${messageOf(error)}` })));

  const theme = el('select');
  theme.setAttribute('aria-label', 'Editor theme');
  for (const [value, label] of THEME_CHOICES) theme.append(el('option', { value, textContent: label, selected: (settings.theme ?? '') === value }));
  theme.addEventListener('change', () => void save({ theme: theme.value || null }));
  const flag = (key: 'minimap' | 'wordWrap' | 'ownBackground', label: string) => {
    const box = el('input', { type: 'checkbox', checked: settings[key] });
    box.addEventListener('change', () => void save({ [key]: box.checked }));
    return el('label', { class: 'inline' }, box, label);
  };

  root.replaceChildren(
    el('h1', { textContent: 'VS Code' }),
    el('p', { class: 'hint', textContent: "Code files open in VS Code's editor in the Files view, colored by the grammars and themes of VS Code itself. The full VS Code (the VS Code Server for the web) opens for the folder at hand." }),
    el('section', {},
      el('h2', { textContent: 'VS Code Server' }),
      el('p', { class: 'hint', textContent: 'Where the browser reaches it, and its connection token. In the oc-forge dev container: http://<address>:35311, with VSCODE_CONNECTION_TOKEN from secrets.env.' }),
      el('div', { class: 'row' }, url),
      el('div', { class: 'row' }, token, saveServer),
      problem,
      settings.serverUrl ? el('p', { class: 'hint' }, 'Opens ', el('code', { textContent: withoutToken(folderUrl ?? settings.serverUrl) })) : null,
    ),
    el('section', {},
      el('h2', { textContent: 'Open' }),
      el('p', { class: 'hint', textContent: directory ? `This chat's folder: ${directory}` : 'No folder is open in OpenChamber; VS Code opens without one.' }),
      el('div', { class: 'row' }, openFolder, copy, browser),
      el('p', { class: 'hint', textContent: 'On the desktop app the link opens in the built-in browser when "Open links in the built-in browser" is on; elsewhere it opens a browser tab. Each chat also has "Open in VS Code" in its menu.' }),
    ),
    el('section', {},
      el('h2', { textContent: 'Editor' }),
      el('label', {}, 'Theme ', theme),
      flag('minimap', 'Minimap'),
      flag('wordWrap', 'Wrap long lines'),
      flag('ownBackground', "The theme's own background (otherwise OpenChamber's)"),
      el('p', { class: 'hint', textContent: `Files it opens: ${allPatterns().join(' ')}. Reopen a file to see a change.` }),
    ),
  );
};

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  // The background frame only answers the chat action.
  if (context.surface === 'background') return;
  const root = document.getElementById('root') as HTMLElement;
  view.directory = context.directory;
  void loadSettings().then((loaded) => {
    view.settings = loaded;
    render(root);
  });
  host.onDirectory((next) => {
    view.directory = next;
    render(root);
  });
});
