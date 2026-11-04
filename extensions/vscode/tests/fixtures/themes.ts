// OpenChamber's built-in themes as it gives them to an extension frame (`openchamber-themes.json`, see its `source`).
import { readFileSync } from 'node:fs';
import type { HostTheme, HostThemeTokens } from '@openchamber/sdk';

interface FixtureTheme {
  mode: 'light' | 'dark';
  tokens: HostThemeTokens;
  /** A frame in a panel docked beside the chat paints the panel's color. */
  docked: Pick<HostThemeTokens, 'background' | 'mutedSurface'>;
}

export const OPENCHAMBER_THEMES: Record<string, FixtureTheme> = JSON.parse(readFileSync(new URL('./openchamber-themes.json', import.meta.url), 'utf8')).themes;

/** One built-in theme as a page's frame (or, `docked`, a rail panel's) gets it. */
export const openChamberTheme = (id: string, docked = false): HostTheme => {
  const theme = OPENCHAMBER_THEMES[id];
  if (!theme) throw new Error(`no theme ${id}`);
  return { mode: theme.mode, tokens: { ...theme.tokens, ...(docked ? theme.docked : {}) } };
};
