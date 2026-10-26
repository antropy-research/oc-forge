// The extension's settings (kept in host storage) and the addresses that open
// a folder or a file in the VS Code Server. Pure.

export interface VscodeSettings {
  /** Where the VS Code Server for the web answers, as the browser reaches it: http(s)://host:port, no path. */
  serverUrl: string | null;
  /** Its connection token (`--connection-token`), sent once in the address; VS Code keeps it in a cookie. */
  token: string | null;
  /** A theme from vscode/themes; null follows OpenChamber's light or dark look. */
  theme: string | null;
  minimap: boolean;
  wordWrap: boolean;
  /** Draw the theme's own editor background instead of OpenChamber's. */
  ownBackground: boolean;
}

export const DEFAULT_SETTINGS: VscodeSettings = { serverUrl: null, token: null, theme: null, minimap: true, wordWrap: false, ownBackground: false };

/** The address of a VS Code Server as typed: http(s), a host, maybe a port, nothing after. */
export const parseServerUrl = (raw: string): string | null => {
  try {
    const url = new URL(raw.trim());
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    // A path prefix is allowed (a proxy may serve VS Code below one); query and fragment are not.
    if (url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Settings as stored; anything missing or malformed falls back to the default. */
export const readSettings = (stored: unknown): VscodeSettings => {
  if (!isRecord(stored)) return { ...DEFAULT_SETTINGS };
  const serverUrl = typeof stored.serverUrl === 'string' ? parseServerUrl(stored.serverUrl) : null;
  const token = typeof stored.token === 'string' && /^[A-Za-z0-9._~-]{1,256}$/.test(stored.token) ? stored.token : null;
  const theme = typeof stored.theme === 'string' && /^[a-z0-9-]{1,40}$/.test(stored.theme) ? stored.theme : null;
  const flag = (key: keyof VscodeSettings) => (typeof stored[key] === 'boolean' ? (stored[key] as boolean) : (DEFAULT_SETTINGS[key] as boolean));
  return { serverUrl, token, theme, minimap: flag('minimap'), wordWrap: flag('wordWrap'), ownBackground: flag('ownBackground') };
};

const withToken = (settings: VscodeSettings, params: URLSearchParams): string => {
  if (settings.token) params.set('tkn', settings.token);
  return `${settings.serverUrl}/?${params}`;
};

/** The address that opens `folder` in VS Code; null while no server is set. */
export const vscodeFolderUrl = (settings: VscodeSettings, folder: string | null): string | null => {
  if (!settings.serverUrl) return null;
  const params = new URLSearchParams();
  if (folder && folder.startsWith('/')) params.set('folder', folder);
  return withToken(settings, params);
};

/**
 * The address that opens a file in VS Code, in `folder` (or the file's own
 * folder), at a line when given: VS Code's web workbench opens the file its
 * `payload` names, as a vscode-remote URI on the server it was loaded from.
 */
export const vscodeFileUrl = (settings: VscodeSettings, path: string, options: { folder?: string | null; line?: number } = {}): string | null => {
  if (!settings.serverUrl || !path.startsWith('/')) return null;
  const folder = options.folder && options.folder.startsWith('/') && path.startsWith(`${options.folder.replace(/\/+$/, '')}/`) ? options.folder : path.slice(0, path.lastIndexOf('/')) || '/';
  const authority = new URL(settings.serverUrl).host;
  const target = `vscode-remote://${authority}${encodeURI(path)}${options.line ? `:${options.line}` : ''}`;
  const payload: [string, string][] = [['openFile', target]];
  if (options.line) payload.push(['gotoLineMode', 'true']);
  const params = new URLSearchParams({ folder, payload: JSON.stringify(payload) });
  return withToken(settings, params);
};

/** An address with its token hidden, to show. */
export const withoutToken = (url: string): string => url.replace(/([?&]tkn=)[^&]*/, '$1…');
