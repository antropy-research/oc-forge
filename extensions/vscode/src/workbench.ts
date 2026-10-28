// What the embedded workbench is told, and which of its requests go where. Pure.

/** The VS Code Server's own workbench configuration (its page's `data-settings`), as far as this extension reads it. */
export interface ServerWorkbenchConfig {
  remoteAuthority?: string;
  serverBasePath?: string;
  enableWorkspaceTrust?: boolean;
  developmentOptions?: Record<string, unknown>;
  callbackRoute?: string;
  productConfiguration?: Record<string, unknown>;
  [key: string]: unknown;
}

/** URI components as VS Code's `URI.revive` takes them. */
export interface UriComponents {
  scheme: string;
  authority: string;
  path: string;
  query?: string;
  fragment?: string;
}

/** A folder on the VS Code Server's machine, as the remote workbench names it. */
export const remoteUri = (authority: string, path: string): UriComponents => ({ scheme: 'vscode-remote', authority, path });

export type ThemeMode = 'light' | 'dark';

/** VS Code's default themes in the release this extension was built against (1.140). */
export const DEFAULT_THEMES: Record<ThemeMode, string> = { light: 'Light 2026', dark: 'Dark 2026' };

/**
 * The plain-data part of the workbench options: the server's configuration,
 * the folder to open, and OpenChamber's defaults. The frame adds the functions
 * (web socket factory, workspace provider, commands) itself.
 */
export const workbenchConfiguration = (
  server: ServerWorkbenchConfig,
  { folder, token, mode, followTheme, defaults = {} }: {
    folder: string | null;
    token: string | null;
    mode: ThemeMode;
    followTheme: boolean;
    /** The part of VS Code this frame is (`roleSettings` in surfaces.ts), as defaults from the start. */
    defaults?: Record<string, unknown>;
  },
): ServerWorkbenchConfig => {
  const authority = server.remoteAuthority ?? '';
  const product = { ...(server.productConfiguration ?? {}) };
  // Telemetry and experiments would only be refused by the frame's CSP; leave them out.
  delete product.tasConfig;
  delete product.aiConfig;
  product.enableTelemetry = false;
  const configurationDefaults: Record<string, unknown> = {
    // OpenChamber is where agents work; VS Code's own chat would need a GitHub sign-in a frame cannot do.
    'chat.disableAIFeatures': true,
    // Its secondary side bar holds that chat; without it, it is an empty column in a narrow panel.
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'workbench.startupEditor': 'none',
    'telemetry.telemetryLevel': 'off',
    'workbench.enableExperiments': false,
    'update.mode': 'none',
    'window.confirmBeforeClose': 'never',
    'workbench.preferredLightColorTheme': DEFAULT_THEMES.light,
    'workbench.preferredDarkColorTheme': DEFAULT_THEMES.dark,
  };
  if (followTheme) configurationDefaults['workbench.colorTheme'] = DEFAULT_THEMES[mode];
  Object.assign(configurationDefaults, defaults);
  return {
    ...server,
    productConfiguration: product,
    ...(token ? { connectionToken: token } : {}),
    ...(folder && authority ? { folderUri: remoteUri(authority, folder) } : {}),
    // OpenChamber already decided to show this folder; VS Code's trust prompt would ask again.
    enableWorkspaceTrust: false,
    configurationDefaults,
    initialColorTheme: { themeType: mode },
  };
};

/**
 * The server path (and query) a workbench URL asks the VS Code Server for, or
 * null when the URL is not the server's. The workbench builds them from its
 * remote authority: remote resources (`/vscode-remote-resource?path=…`), its
 * static files and web extension resources.
 */
export const serverPathOf = (url: string, authority: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.host !== authority) return null;
  return `${parsed.pathname}${parsed.search}`;
};

/** Hosts the workbench may reach through the service besides the VS Code Server: the extension gallery and VS Code's CDN. */
export const EXTERNAL_HOST_SUFFIXES = [
  'marketplace.visualstudio.com',
  '.vsassets.io',
  '.gallerycdn.vsassets.io',
  '.vscode-cdn.net',
  '.vscode-unpkg.net',
  'open-vsx.org',
  '.open-vsx.org',
] as const;

export const isExternalAllowed = (url: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return false;
  const host = parsed.hostname.toLowerCase();
  return EXTERNAL_HOST_SUFFIXES.some((suffix) => (suffix.startsWith('.') ? host.endsWith(suffix) : host === suffix));
};

/** The workbench configuration a VS Code Server page carries in `<meta id="vscode-workbench-web-configuration" data-settings="…">`. */
export const readServerPage = (html: string): { config: ServerWorkbenchConfig; base: string } | null => {
  const attribute = (id: string): string | null => {
    const match = new RegExp(`id="${id}"\\s+data-settings="([^"]*)"`).exec(html);
    if (!match) return null;
    return match[1]!
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'")
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&');
  };
  const settings = attribute('vscode-workbench-web-configuration');
  const base = attribute('vscode-workbench-web-base-url');
  if (!settings || base === null) return null;
  try {
    const config = JSON.parse(settings) as ServerWorkbenchConfig;
    if (typeof config !== 'object' || config === null) return null;
    return { config, base };
  } catch {
    return null;
  }
};

/** The commit a base URL like `/stable-<commit>/static` names, or null. */
export const commitOfBase = (base: string): string | null => /\/(?:stable|insider|exploration)-([0-9a-f]{40})\/static\/?$/.exec(base)?.[1] ?? null;

/**
 * A 52-character base-32 name for a webview origin, the shape of VS Code's
 * SHA-256 one, for a page without crypto.subtle (plain HTTP). It names
 * webviews apart; it guards nothing.
 */
export const webviewOriginName = (parentOrigin: string, salt: string): string => {
  const text = JSON.stringify({ parentOrigin, salt });
  let name = '';
  for (let seed = 0; name.length < 52; seed++) {
    let hash = (0x811c9dc5 ^ Math.imul(seed, 0x9e3779b1)) >>> 0;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    name += hash.toString(32).padStart(7, '0');
  }
  return name.slice(0, 52);
};
