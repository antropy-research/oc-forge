// The extension's settings (kept in host storage). Pure.

export interface VscodeSettings {
  /**
   * Where the VS Code Server for the web answers, as the machine running
   * OpenChamber reaches it: http(s)://host:port, maybe a path prefix. Only the
   * extension's service talks to it; the browser never does.
   */
  serverUrl: string | null;
  /** Its connection token (`--connection-token`). */
  token: string | null;
  /**
   * VS Code follows OpenChamber's theme: its light or dark mode, its colors on VS Code's default themes, its code
   * font (`src/theme.ts`). Off: VS Code's own themes as they are.
   */
  followTheme: boolean;
}

export const DEFAULT_SETTINGS: VscodeSettings = { serverUrl: null, token: null, followTheme: true };

/** The address of a VS Code Server as typed: http(s), a host, maybe a port and a path prefix, nothing after. */
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

/** A connection token as VS Code accepts it. */
export const isConnectionToken = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._~-]{1,256}$/.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Settings as stored; anything missing or malformed falls back to the default. */
export const readSettings = (stored: unknown): VscodeSettings => {
  if (!isRecord(stored)) return { ...DEFAULT_SETTINGS };
  const serverUrl = typeof stored.serverUrl === 'string' ? parseServerUrl(stored.serverUrl) : null;
  const token = isConnectionToken(stored.token) ? stored.token : null;
  const followTheme = typeof stored.followTheme === 'boolean' ? stored.followTheme : DEFAULT_SETTINGS.followTheme;
  return { serverUrl, token, followTheme };
};

/** What "Open in VS Code" asks the VS Code view to show: a folder, maybe a file at a line. */
export interface OpenRequest {
  folder: string;
  file?: string;
  line?: number;
  /** When it was asked (ms); a view answers each request once. */
  at: number;
}

export const readOpenRequest = (stored: unknown): OpenRequest | null => {
  if (!isRecord(stored)) return null;
  const { folder, file, line, at } = stored;
  if (typeof folder !== 'string' || !folder.startsWith('/') || folder.length > 4096) return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  const request: OpenRequest = { folder, at };
  if (typeof file === 'string' && file.startsWith('/') && file.length <= 4096) request.file = file;
  if (typeof line === 'number' && Number.isInteger(line) && line > 0) request.line = line;
  return request;
};
