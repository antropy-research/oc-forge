import { describe, expect, test } from 'bun:test';
import type { HostThemeTokens } from '@openchamber/sdk';
import {
  AA_TEXT,
  COLOR_RECIPES,
  colorOf,
  contrastRatio,
  DEFAULT_THEMES,
  fontSettings,
  lookInMemory,
  lookSettings,
  parseColor,
  recipeTokens,
  scopeApplies,
  SYNTAX_RULES,
  vscodeColors,
  vscodeTokenColors,
  type InspectedSetting,
  type TextMateRule,
} from '../src/theme.ts';
import { OPENCHAMBER_THEMES, openChamberTheme } from './fixtures/themes.ts';

type Settings = Record<string, unknown>;
const isRecord = (value: unknown): value is Settings => typeof value === 'object' && value !== null && !Array.isArray(value);

/** VS Code's merge of configuration layers (`ConfigurationModel.mergeContents`): objects key by key, the rest replaced. */
const merge = (...layers: unknown[]): unknown => {
  let result: unknown;
  for (const layer of layers) {
    if (layer === undefined) continue;
    if (isRecord(result) && isRecord(layer)) {
      const into: Settings = structuredClone(result);
      for (const [key, value] of Object.entries(layer)) into[key] = isRecord(into[key]) && isRecord(value) ? merge(into[key], value) : structuredClone(value);
      result = into;
    } else result = structuredClone(layer);
  }
  return result;
};

const scopeMatches = (key: string, theme: string) => key.startsWith('[') && key.endsWith(']') && scopeApplies(key, theme);

/**
 * The colors VS Code shows on `theme` for a merged `workbench.colorCustomizations` (`ColorThemeData.setCustomColors`):
 * the keys for every theme, then those of each scope that applies, in order, skipping empty values.
 */
const shownColors = (customizations: unknown, theme: string): Record<string, string> => {
  const shown: Record<string, string> = {};
  if (!isRecord(customizations)) return shown;
  const specific: Settings = {};
  for (const [key, value] of Object.entries(customizations)) {
    if (!key.startsWith('[')) {
      if (typeof value === 'string') shown[key] = value;
    } else if (isRecord(value) && scopeMatches(key, theme)) {
      for (const [subkey, subvalue] of Object.entries(value)) if (subvalue) specific[subkey] = subvalue;
    }
  }
  for (const [key, value] of Object.entries(specific)) if (typeof value === 'string') shown[key] = value;
  return shown;
};

/** VS Code's rule list for `editor.tokenColorCustomizations` on `theme` (`setCustomTokenColors`): every theme's, then the scopes'. */
const shownRules = (customizations: unknown, theme: string): TextMateRule[] => {
  if (!isRecord(customizations)) return [];
  const groupRules = (block: Settings): TextMateRule[] => [
    ...Object.entries(block).filter(([key, value]) => ['comments', 'strings', 'keywords', 'numbers', 'types', 'functions', 'variables'].includes(key) && value).map(([key, value]) => ({ name: `group ${key}`, scope: key, settings: { foreground: value } })),
    ...(Array.isArray(block.textMateRules) ? (block.textMateRules as TextMateRule[]) : []),
  ];
  const general = Object.fromEntries(Object.entries(customizations).filter(([key]) => !key.startsWith('[')));
  const specific: Settings = {};
  for (const [key, value] of Object.entries(customizations)) {
    if (!isRecord(value) || !scopeMatches(key, theme)) continue;
    for (const [subkey, subvalue] of Object.entries(value)) {
      if (Array.isArray(specific[subkey]) && Array.isArray(subvalue)) specific[subkey] = [...(specific[subkey] as unknown[]), ...subvalue];
      else if (subvalue) specific[subkey] = subvalue;
    }
  }
  return [...groupRules(general), ...groupRules(specific)];
};

/** A configuration service's `inspect` over given layers. */
const inspector = (layers: Record<string, InspectedSetting>) => (key: string): InspectedSetting => layers[key] ?? {};

const light = openChamberTheme('openchamber-light');
const dark = openChamberTheme('openchamber-dark');
const LIGHT = DEFAULT_THEMES.light;
const DARK = DEFAULT_THEMES.dark;

describe("OpenChamber's tokens as VS Code's colors", () => {
  test('every color comes from a token: as it is, faded, or laid over another token', () => {
    const names = new Set(Object.keys(light.tokens));
    for (const [key, recipe] of Object.entries(COLOR_RECIPES)) {
      for (const token of recipeTokens(recipe)) expect(names.has(token) ? token : `${key} reads ${token}`).toBe(token);
    }
    for (const id of Object.keys(OPENCHAMBER_THEMES)) {
      const { tokens } = openChamberTheme(id);
      const colors = vscodeColors(tokens);
      expect(Object.keys(colors).sort()).toEqual(Object.keys(COLOR_RECIPES).sort());
      for (const [key, value] of Object.entries(colors)) {
        expect(value).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
        expect(value).toBe(colorOf(COLOR_RECIPES[key]!, tokens)!);
        const recipe = COLOR_RECIPES[key]!;
        // A plain token is that very color.
        if (typeof recipe === 'string') expect(parseColor(value)).toEqual(parseColor(tokens[recipe] as string));
      }
    }
  });

  test("each frame's surface is the color OpenChamber paints around it; floating surfaces and selections are OpenChamber's", () => {
    const docked = openChamberTheme('openchamber-light', true);
    const colors = vscodeColors(docked.tokens);
    for (const key of ['editor.background', 'sideBar.background', 'sideBarSectionHeader.background', 'panel.background', 'terminal.background']) expect(colors[key]).toBe(docked.tokens.background);
    for (const key of ['menu.background', 'quickInput.background', 'editorWidget.background', 'notifications.background', 'input.background', 'dropdown.background']) expect(colors[key]).toBe(docked.tokens.elevated);
    expect(colors['list.activeSelectionBackground']).toBe(docked.tokens.selection);
    expect(colors['list.hoverBackground']).toBe(docked.tokens.hover);
    expect(colors['button.background']).toBe(docked.tokens.primary);
    expect(colors['textLink.foreground']).toBe(docked.tokens.primaryText);
    // Faded: the token's alpha times the recipe's; laid over: a solid mix; shaded: away from its text's lightness.
    expect(colorOf(['foreground', 0.18], { ...docked.tokens, foreground: '#000000' })).toBe('#0000002e');
    expect(colorOf(['primary', 0.5, 'background'], { ...docked.tokens, primary: '#ff0000', background: '#0000ff' })).toBe('#800080');
    expect(colorOf({ shade: 'primary', from: 'primaryForeground', by: 0.5 }, { ...docked.tokens, primary: '#808080', primaryForeground: '#ffffff' })).toBe('#404040');
    expect(colorOf({ shade: 'primary', from: 'primaryForeground', by: 0.5 }, { ...docked.tokens, primary: '#808080', primaryForeground: '#000000' })).toBe('#c0c0c0');
    // Readable: the code's punctuation color, which brackets take too.
    const punctuation = vscodeTokenColors(docked.tokens)!.textMateRules.find((rule) => rule.name === 'OpenChamber punctuation')!.settings.foreground;
    expect(colors['editorBracketHighlight.foreground1']).toBe(punctuation as string);
  });

  test('covers the chrome a user sees', () => {
    const keys = Object.keys(COLOR_RECIPES);
    const prefixes = [
      'editor.', 'sideBar.', 'sideBarSectionHeader.', 'panel.', 'terminal.', 'tab.', 'editorGroupHeader.', 'titleBar.', 'statusBar.', 'activityBar.',
      'editorWidget.', 'editorSuggestWidget.', 'editorHoverWidget.', 'menu.', 'quickInput.', 'quickInputList.', 'input.', 'dropdown.', 'notifications.',
      'notificationCenterHeader.', 'button.', 'badge.', 'textLink.', 'scrollbarSlider.', 'list.', 'checkbox.', 'breadcrumb.',
    ];
    for (const prefix of prefixes) expect(keys.some((key) => key.startsWith(prefix)) ? prefix : `nothing for ${prefix}`).toBe(prefix);
    for (const key of [
      'focusBorder', 'widget.border', 'foreground', 'descriptionForeground', 'editor.background', 'editor.foreground', 'editor.lineHighlightBackground', 'editor.selectionBackground',
      'sideBar.background', 'sideBarSectionHeader.background', 'panel.background', 'terminal.background', 'terminal.foreground', 'tab.activeBackground', 'tab.inactiveBackground',
      'editorGroupHeader.tabsBackground', 'list.activeSelectionBackground', 'list.activeSelectionForeground', 'list.hoverBackground', 'list.inactiveSelectionBackground',
      'button.background', 'button.foreground', 'badge.background', 'badge.foreground', 'textLink.foreground', 'scrollbarSlider.background', 'menu.background', 'menu.selectionBackground',
      'quickInput.background', 'input.background', 'input.border', 'dropdown.background', 'notifications.background',
    ]) expect(key in COLOR_RECIPES ? key : `missing ${key}`).toBe(key);
    // VS Code draws the current line's border whenever a theme sets one: it stays unset, as OpenChamber's Files view has none.
    expect('editor.lineHighlightBorder' in COLOR_RECIPES).toBe(false);
  });

  test("a token that isn't a color OpenChamber's themes hold leaves VS Code's own color, never a wrong one", () => {
    const tokens: HostThemeTokens = { ...light.tokens, background: 'oklch(0.9 0.02 85)', selection: 'not a color' };
    const colors = vscodeColors(tokens);
    expect(colors['editor.background']).toBeUndefined();
    expect(colors['list.activeSelectionBackground']).toBeUndefined();
    expect(colors['editorStickyScrollHover.background']).toBeUndefined();
    expect(colors['editor.foreground']).toBe(light.tokens.foreground);
    expect(parseColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseColor('rgba(10 20 30 / 50%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseColor('#0000ff80')!.a).toBeCloseTo(128 / 255);
    expect(parseColor('rgb(300, 0, 0)')).toBeNull();
  });

  test("fonts: OpenChamber's monospace one is the editor's (and so the terminal's), its interface font the Markdown preview's", () => {
    expect(fontSettings(light.tokens)).toEqual({ 'editor.fontFamily': light.tokens.mono, 'markdown.preview.fontFamily': light.tokens.font });
    expect(fontSettings({ ...light.tokens, mono: 'x; } body { color: red', font: '' })).toEqual({});
  });
});

describe('scoped to the default themes', () => {
  test("the look is under the default theme of OpenChamber's mode, nothing for every theme", () => {
    const look = lookSettings(light);
    expect(Object.keys(look['workbench.colorCustomizations'] as Settings)).toEqual([`[${LIGHT}]`]);
    expect(Object.keys(look['editor.tokenColorCustomizations'] as Settings)).toEqual([`[${LIGHT}]`]);
    expect(Object.keys(lookSettings(dark)['workbench.colorCustomizations'] as Settings)).toEqual([`[${DARK}]`]);
    // On any other theme the look shows nothing.
    expect(shownColors(look['workbench.colorCustomizations'], 'Monokai')).toEqual({});
    expect(shownColors(look['workbench.colorCustomizations'], DARK)).toEqual({});
    expect(shownRules(look['editor.tokenColorCustomizations'], 'Light Modern')).toEqual([]);
    expect(shownColors(look['workbench.colorCustomizations'], LIGHT)).toEqual(vscodeColors(light.tokens));
  });

  test('VS Code 1.140, 1.143 and 1.144 name their default themes the same', () => {
    expect(DEFAULT_THEMES).toEqual({ light: 'Light 2026', dark: 'Dark 2026' });
  });

  test('theme scopes match as VS Code matches them', () => {
    expect(scopeApplies('[Light 2026]', LIGHT)).toBe(true);
    expect(scopeApplies('[Light 2026]', DARK)).toBe(false);
    expect(scopeApplies('[*2026*]', DARK)).toBe(true);
    expect(scopeApplies('[Light*]', LIGHT)).toBe(true);
    expect(scopeApplies('[*2026]', LIGHT)).toBe(true);
    expect(scopeApplies('[Abyss][Light 2026]', LIGHT)).toBe(true);
    expect(scopeApplies('[Monokai]', LIGHT)).toBe(false);
    expect(scopeApplies('editor.background', LIGHT)).toBe(false);
  });
});

describe("the user's own customizations win, key by key", () => {
  const user = {
    'editor.background': '#000001',
    'sideBar.background': '#000002',
    [`[${LIGHT}]`]: { 'editor.background': '#000003', 'panel.background': '#000004' },
    '[Monokai]': { 'terminal.background': '#000005' },
  };

  test('as VS Code starts: its defaults below every layer of the user', () => {
    const defaults = lookSettings(light)['workbench.colorCustomizations'];
    const shown = shownColors(merge(defaults, user), LIGHT);
    // The user's for this theme over OpenChamber's, and OpenChamber's elsewhere.
    expect(shown['editor.background']).toBe('#000003');
    expect(shown['panel.background']).toBe('#000004');
    expect(shown['terminal.background']).toBe(light.tokens.background);
  });

  test("once VS Code runs, in memory: the user's for the theme, else theirs for every theme, else OpenChamber's", () => {
    const defaults = lookSettings(light)['workbench.colorCustomizations'];
    const memory = lookInMemory(light, inspector({ 'workbench.colorCustomizations': { defaultValue: defaults, userValue: user } }));
    const shown = shownColors(merge(defaults, user, memory['workbench.colorCustomizations']), LIGHT);
    expect(shown['editor.background']).toBe('#000003');
    expect(shown['panel.background']).toBe('#000004');
    expect(shown['sideBar.background']).toBe('#000002');
    expect(shown['terminal.background']).toBe(light.tokens.background);
    const ours = vscodeColors(light.tokens);
    for (const [key, color] of Object.entries(ours)) if (!['editor.background', 'panel.background', 'sideBar.background'].includes(key)) expect(shown[key]).toBe(color);
    // Another theme the user picked shows exactly their customizations of it.
    expect(shownColors(merge(defaults, user, memory['workbench.colorCustomizations']), 'Monokai')).toEqual({ 'editor.background': '#000001', 'sideBar.background': '#000002', 'terminal.background': '#000005' });
  });

  test("a workspace's settings win over the user's, and a theme changed live replaces the look VS Code started with", () => {
    const defaults = lookSettings(light)['workbench.colorCustomizations'];
    const workspace = { [`[${LIGHT}]`]: { 'editor.background': '#00000a' } };
    const other = openChamberTheme('nord-light');
    const memory = lookInMemory(other, inspector({ 'workbench.colorCustomizations': { defaultValue: defaults, userValue: user, workspaceValue: workspace } }));
    const shown = shownColors(merge(defaults, user, workspace, memory['workbench.colorCustomizations']), LIGHT);
    expect(shown['editor.background']).toBe('#00000a');
    expect(shown['terminal.background']).toBe(other.tokens.background);
    expect(shown['menu.background']).toBe(other.tokens.elevated);
  });

  test('a color the look VS Code started with had and the new one lacks goes back to the theme\'s own', () => {
    const before = lookSettings(light)['workbench.colorCustomizations'];
    const without: typeof light = { mode: 'light', tokens: { ...light.tokens, syntaxFunction: undefined } };
    const memory = lookInMemory(without, inspector({ 'workbench.colorCustomizations': { defaultValue: before } }));
    const shown = shownColors(merge(before, memory['workbench.colorCustomizations']), LIGHT);
    expect(shown['terminal.ansiBlue']).toBeUndefined();
    expect(shown['terminal.background']).toBe(light.tokens.background);
  });

  test("memory keeps the other mode's last look, so the theme VS Code is leaving keeps its colors until the other loads", () => {
    const memory = lookInMemory(dark, inspector({}), light);
    const colors = memory['workbench.colorCustomizations'] as Settings;
    expect(Object.keys(colors).sort()).toEqual([`[${DARK}]`, `[${LIGHT}]`]);
    expect(shownColors(colors, DARK)['editor.background']).toBe(dark.tokens.background);
    expect(shownColors(colors, LIGHT)['editor.background']).toBe(light.tokens.background);
  });

  test("fonts: OpenChamber's while the user set none", () => {
    const fonts = (inspected: InspectedSetting) => lookInMemory(light, inspector({ 'editor.fontFamily': inspected }))['editor.fontFamily'];
    // As VS Code started: nothing to hold in memory.
    expect(fonts({ defaultValue: light.tokens.mono })).toBeUndefined();
    // OpenChamber's changed since: the new one.
    expect(fonts({ defaultValue: 'Menlo' })).toBe(light.tokens.mono);
    // The user's own, in any layer: theirs.
    expect(fonts({ defaultValue: 'Menlo', userValue: 'Fira Code' })).toBeUndefined();
    expect(fonts({ defaultValue: 'Menlo', workspaceValue: 'Fira Code' })).toBeUndefined();
  });

  test('code colors: a group the user set takes its scopes over, and their rules come after OpenChamber\'s', () => {
    const defaults = lookSettings(light)['editor.tokenColorCustomizations'];
    const userRule = { scope: 'keyword.operator', settings: { foreground: '#000007' } };
    const userValue = { comments: '#000006', [`[${LIGHT}]`]: { strings: '#000008', textMateRules: [userRule] } };
    const memory = lookInMemory(light, inspector({ 'editor.tokenColorCustomizations': { defaultValue: defaults, userValue } }));
    const rules = shownRules(merge(defaults, userValue, memory['editor.tokenColorCustomizations']), LIGHT);
    const names = rules.map((rule) => rule.name ?? rule.scope);
    expect(names).not.toContain('OpenChamber comment');
    expect(names).not.toContain('OpenChamber string');
    expect(names).toContain('OpenChamber keyword');
    expect(names).toContain('OpenChamber operator');
    // The user's rule for operators comes after OpenChamber's, so it wins.
    expect(names.lastIndexOf('keyword.operator')).toBeGreaterThan(names.indexOf('OpenChamber operator'));
    expect(names).toContain('group comments');
    expect(names).toContain('group strings');
  });
});

describe('contrast in every built-in OpenChamber theme (WCAG AA for text)', () => {
  /** Text on a surface as VS Code paints them: [text, surface, what the surface sits on]. */
  const TEXT_PAIRS: [string, string, string][] = [
    ['editor.foreground', 'editor.background', 'editor.background'],
    ['sideBar.foreground', 'sideBar.background', 'sideBar.background'],
    ['sideBarSectionHeader.foreground', 'sideBarSectionHeader.background', 'sideBar.background'],
    ['terminal.foreground', 'terminal.background', 'terminal.background'],
    ['panelTitle.activeForeground', 'panel.background', 'panel.background'],
    ['panelTitle.inactiveForeground', 'panel.background', 'panel.background'],
    ['tab.activeForeground', 'tab.activeBackground', 'editor.background'],
    ['tab.inactiveForeground', 'tab.inactiveBackground', 'editorGroupHeader.tabsBackground'],
    ['titleBar.activeForeground', 'titleBar.activeBackground', 'titleBar.activeBackground'],
    ['statusBar.foreground', 'statusBar.background', 'statusBar.background'],
    ['activityBar.inactiveForeground', 'activityBar.background', 'activityBar.background'],
    ['descriptionForeground', 'sideBar.background', 'sideBar.background'],
    ['editorLineNumber.foreground', 'editor.background', 'editor.background'],
    ['editorBracketHighlight.foreground1', 'editor.background', 'editor.background'],
    ['breadcrumb.foreground', 'breadcrumb.background', 'editor.background'],
    ['list.activeSelectionForeground', 'list.activeSelectionBackground', 'sideBar.background'],
    ['list.inactiveSelectionForeground', 'list.inactiveSelectionBackground', 'sideBar.background'],
    ['list.hoverForeground', 'list.hoverBackground', 'sideBar.background'],
    ['list.highlightForeground', 'sideBar.background', 'sideBar.background'],
    ['list.focusHighlightForeground', 'list.activeSelectionBackground', 'sideBar.background'],
    ['menu.foreground', 'menu.background', 'menu.background'],
    ['menu.selectionForeground', 'menu.selectionBackground', 'menu.background'],
    ['quickInput.foreground', 'quickInput.background', 'quickInput.background'],
    ['quickInputList.focusForeground', 'quickInputList.focusBackground', 'quickInput.background'],
    ['quickInputList.focusHighlightForeground', 'quickInputList.focusBackground', 'quickInput.background'],
    ['input.foreground', 'input.background', 'input.background'],
    ['input.placeholderForeground', 'input.background', 'input.background'],
    ['dropdown.foreground', 'dropdown.background', 'dropdown.background'],
    ['editorWidget.foreground', 'editorWidget.background', 'editorWidget.background'],
    ['editorSuggestWidget.selectedForeground', 'editorSuggestWidget.selectedBackground', 'editorSuggestWidget.background'],
    ['editorSuggestWidget.highlightForeground', 'editorSuggestWidget.background', 'editorSuggestWidget.background'],
    ['editorSuggestWidget.focusHighlightForeground', 'editorSuggestWidget.selectedBackground', 'editorSuggestWidget.background'],
    ['statusBarItem.prominentForeground', 'statusBarItem.prominentHoverBackground', 'statusBar.background'],
    ['extensionButton.prominentForeground', 'extensionButton.prominentHoverBackground', 'editor.background'],
    ['notifications.foreground', 'notifications.background', 'notifications.background'],
    ['notificationLink.foreground', 'notifications.background', 'notifications.background'],
    ['textLink.foreground', 'editor.background', 'editor.background'],
    ['button.foreground', 'button.background', 'button.background'],
    ['button.foreground', 'button.hoverBackground', 'button.hoverBackground'],
    ['button.secondaryForeground', 'button.secondaryBackground', 'button.secondaryBackground'],
    ['badge.foreground', 'badge.background', 'badge.background'],
    ['statusBarItem.remoteForeground', 'statusBarItem.remoteBackground', 'statusBar.background'],
    ['errorForeground', 'editor.background', 'editor.background'],
    ['gitDecoration.modifiedResourceForeground', 'sideBar.background', 'sideBar.background'],
    ['gitDecoration.untrackedResourceForeground', 'sideBar.background', 'sideBar.background'],
    ['gitDecoration.deletedResourceForeground', 'sideBar.background', 'sideBar.background'],
    ['gitDecoration.conflictingResourceForeground', 'sideBar.background', 'sideBar.background'],
  ];

  test('text on every surface it is drawn on, in the page and in a docked panel', () => {
    const failures: string[] = [];
    let lowest = Infinity;
    for (const id of Object.keys(OPENCHAMBER_THEMES)) {
      for (const docked of [false, true]) {
        const colors = vscodeColors(openChamberTheme(id, docked).tokens);
        for (const [text, surface, under] of TEXT_PAIRS) {
          const ratio = contrastRatio(colors[text]!, colors[surface]!, colors[under]!)!;
          lowest = Math.min(lowest, ratio);
          if (!(ratio >= AA_TEXT)) failures.push(`${id}${docked ? ' (docked)' : ''}: ${text} on ${surface} ${ratio.toFixed(2)}`);
        }
        // The focus outline, a 1 px line: at least 3:1 (WCAG's non-text contrast).
        const focus = contrastRatio(colors.focusBorder!, colors['editor.background']!)!;
        if (!(focus >= 3)) failures.push(`${id}${docked ? ' (docked)' : ''}: focusBorder ${focus.toFixed(2)}`);
      }
    }
    expect(failures).toEqual([]);
    expect(lowest).toBeGreaterThanOrEqual(AA_TEXT);
  });

  test('code colors are readable on the editor: OpenChamber\'s own where they are, else moved just far enough', () => {
    let kept = 0;
    let moved = 0;
    for (const id of Object.keys(OPENCHAMBER_THEMES)) {
      for (const docked of [false, true]) {
        const { tokens } = openChamberTheme(id, docked);
        const rules = vscodeTokenColors(tokens)!.textMateRules;
        expect(rules.length).toBe(SYNTAX_RULES.length);
        for (const [index, rule] of rules.entries()) {
          const foreground = rule.settings.foreground as string;
          expect(contrastRatio(foreground, tokens.background)!).toBeGreaterThanOrEqual(AA_TEXT);
          const own = tokens[SYNTAX_RULES[index]!.token] as string;
          if (contrastRatio(own, tokens.background)! >= AA_TEXT) {
            expect(parseColor(foreground)).toEqual(parseColor(own));
            kept += 1;
          } else {
            // Moved toward black or white only as far as AA needs.
            expect(contrastRatio(foreground, tokens.background)!).toBeLessThan(AA_TEXT + 0.6);
            moved += 1;
          }
        }
      }
    }
    expect(kept).toBeGreaterThan(moved);
  });
});
