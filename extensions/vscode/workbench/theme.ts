// OpenChamber's look in a running workbench (`src/theme.ts` has the look itself): VS Code switches between its
// light and dark default themes the way it follows a system's mode, and takes OpenChamber's colors as its theme
// changes, without a reload and without writing the user's settings.
import type { HostTheme } from '@openchamber/sdk';
import { COLOR_SETTING, FONT_SETTINGS, lookInMemory, modeOfTheme, sameSetting, TOKEN_SETTING, type ThemeMode } from '../src/theme.ts';
import { MEMORY_TARGET, type ConfigurationService, type Disposable, type VscodeServices } from './vscode.ts';

/** Every setting OpenChamber's look sets. */
const LOOK_SETTINGS: readonly string[] = [COLOR_SETTING, TOKEN_SETTING, ...FONT_SETTINGS];

const SCHEME_QUERY = /^\s*\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)\s*$/i;

/** A `MediaQueryList` for one `prefers-color-scheme` query, answered from OpenChamber's mode. */
class SchemeQuery extends EventTarget {
  onchange: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null = null;

  constructor(readonly media: string, private readonly scheme: ThemeMode, private readonly mode: () => ThemeMode) {
    super();
  }

  get matches(): boolean {
    return this.mode() === this.scheme;
  }

  addListener(listener: ((event: MediaQueryListEvent) => unknown) | null): void {
    if (listener) this.addEventListener('change', listener as EventListener);
  }

  removeListener(listener: ((event: MediaQueryListEvent) => unknown) | null): void {
    if (listener) this.removeEventListener('change', listener as EventListener);
  }

  changed(): void {
    const event = new MediaQueryListEvent('change', { matches: this.matches, media: this.media });
    this.dispatchEvent(event);
    this.onchange?.call(this as unknown as MediaQueryList, event);
  }
}

/**
 * The color scheme this frame's page prefers, as `matchMedia('(prefers-color-scheme: …)')` answers it: OpenChamber's
 * mode. A browser answers a frame with the system's scheme, whatever its page shows, and VS Code picks its theme from
 * that answer when `window.autoDetectColorScheme` is on: its preferred light theme or its preferred dark one, as a
 * desktop VS Code follows the system. Here OpenChamber is that system. Every other media query is the browser's.
 */
export const preferOpenChamberScheme = (target: Window, initial: ThemeMode): { set(mode: ThemeMode): void } => {
  let mode = initial;
  const native = target.matchMedia.bind(target);
  const queries = new Map<string, SchemeQuery>();
  target.matchMedia = (query: string): MediaQueryList => {
    const scheme = SCHEME_QUERY.exec(query)?.[1]?.toLowerCase() as ThemeMode | undefined;
    if (!scheme) return native(query);
    let list = queries.get(scheme);
    if (!list) queries.set(scheme, (list = new SchemeQuery(query, scheme, () => mode)));
    return list as unknown as MediaQueryList;
  };
  return {
    set(next) {
      if (next === mode) return;
      mode = next;
      for (const query of queries.values()) query.changed();
    },
  };
};

const log = (message: string, error?: unknown): void => console.warn(`[OpenChamber VS Code] ${message}`, error ?? '');

/**
 * Keeps OpenChamber's look in VS Code's memory configuration (`lookInMemory`): at once, whenever OpenChamber's theme
 * changes (`update`), and whenever the user's own settings of the look change, so that theirs keep winning. The
 * memory target is above the user's settings and is never written anywhere; it lasts as long as this workbench.
 */
export const keepLook = (services: VscodeServices, initial: HostTheme): { update(theme: HostTheme): void } & Disposable => {
  const configuration = services.get<ConfigurationService>('configurationService');
  /** The theme OpenChamber shows, and the last one it showed in each mode. */
  let current = initial;
  const shown: Partial<Record<ThemeMode, HostTheme>> = { [modeOfTheme(initial)]: initial };
  let applying = false;
  const apply = (): void => {
    const otherMode: ThemeMode = modeOfTheme(current) === 'dark' ? 'light' : 'dark';
    const memory = lookInMemory(current, (key) => configuration.inspect(key), shown[otherMode]);
    applying = true;
    try {
      for (const [key, value] of Object.entries(memory)) {
        if (sameSetting(configuration.inspect(key).memoryValue, value)) continue;
        configuration.updateValue(key, value, MEMORY_TARGET).catch((error) => log(`could not set ${key}`, error));
      }
    } finally {
      applying = false;
    }
  };
  const listener = configuration.onDidChangeConfiguration((event) => {
    // Its own changes come back at once (the memory target changes synchronously); the user's change it again.
    if (applying || event.source === MEMORY_TARGET) return;
    if (LOOK_SETTINGS.some((key) => event.affectsConfiguration(key))) apply();
  });
  apply();
  return {
    update(theme) {
      current = theme;
      shown[modeOfTheme(theme)] = theme;
      apply();
    },
    dispose: () => listener.dispose(),
  };
};
