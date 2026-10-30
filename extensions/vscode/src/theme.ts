// OpenChamber's look in VS Code: the theme OpenChamber gives each frame (`HostReadyContext.theme`) as VS Code's own
// documented settings. Its colors go in `workbench.colorCustomizations` and its code colors in
// `editor.tokenColorCustomizations`, both scoped to VS Code's default theme of OpenChamber's mode, so that any other
// theme the user picks in VS Code stays as its author made it; its monospace font is the editor's (and so the
// terminal's). They are defaults, never a lock: whatever the user sets wins, key by key (`lookInMemory`). Pure.
import type { HostTheme, HostThemeTokens } from '@openchamber/sdk';

export type ThemeMode = 'light' | 'dark';

/** VS Code's default themes, the same in every release this extension supports (1.140–1.144). */
export const DEFAULT_THEMES: Record<ThemeMode, string> = { light: 'Light 2026', dark: 'Dark 2026' };

export const modeOfTheme = (theme: HostTheme): ThemeMode => (theme.mode === 'dark' ? 'dark' : 'light');

/** The settings key that scopes customizations to one theme, as VS Code reads it: `[Light 2026]`. */
export const themeScope = (name: string): string => `[${name}]`;

// Colors -------------------------------------------------------------------------------------------------------------

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const channel = (text: string, max: number): number | null => {
  const value = text.endsWith('%') ? (Number(text.slice(0, -1)) / 100) * max : text ? Number(text) : NaN;
  return Number.isFinite(value) && value >= 0 && value <= max ? value : null;
};

/** A CSS hex or rgb()/rgba() color, the forms OpenChamber's themes hold; null for anything else. */
export const parseColor = (value: string): Rgba | null => {
  const text = value.trim();
  const hex = /^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.exec(text)?.[1];
  if (hex) {
    const full = hex.length < 5 ? [...hex].map((digit) => digit + digit).join('') : hex;
    const byte = (index: number) => parseInt(full.slice(index, index + 2), 16);
    return { r: byte(0), g: byte(2), b: byte(4), a: full.length === 8 ? byte(6) / 255 : 1 };
  }
  const rgb = /^rgba?\(\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*[,\s]\s*([\d.]+%?)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i.exec(text);
  if (!rgb) return null;
  const r = channel(rgb[1] ?? '', 255);
  const g = channel(rgb[2] ?? '', 255);
  const b = channel(rgb[3] ?? '', 255);
  const a = rgb[4] === undefined ? 1 : channel(rgb[4], 1);
  return r === null || g === null || b === null || a === null ? null : { r, g, b, a };
};

const byteHex = (value: number): string => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0');

/** `#rrggbb`, or `#rrggbbaa` when not opaque: the only forms VS Code's color settings take. */
const hexOf = ({ r, g, b, a }: Rgba): string => `#${byteHex(r)}${byteHex(g)}${byteHex(b)}${a < 1 ? byteHex(a * 255) : ''}`;

/** `front` painted over `back`. */
const over = (front: Rgba, back: Rgba): Rgba => {
  const a = front.a + back.a * (1 - front.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (f: number, b: number) => (f * front.a + b * back.a * (1 - front.a)) / a;
  return { r: mix(front.r, back.r), g: mix(front.g, back.g), b: mix(front.b, back.b), a };
};

const luminance = ({ r, g, b }: Rgba): number => {
  const linear = (value: number) => (value / 255 <= 0.04045 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
};

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };

const ratio = (a: Rgba, b: Rgba): number => {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** WCAG AA for body text. */
export const AA_TEXT = 4.5;

/**
 * Text in `color` on the opaque `surface`, readable: the color itself when it has AA contrast there, else moved
 * toward black or white (whichever contrasts more with the surface) just far enough. OpenChamber's own rule for
 * the tinted text it computes (`readableText` in its theme code), here for code colors.
 */
const readableOn = (color: Rgba, surface: Rgba): Rgba => {
  const solid = over(color, surface);
  if (ratio(solid, surface) >= AA_TEXT) return solid;
  const target = ratio(BLACK, surface) >= ratio(WHITE, surface) ? BLACK : WHITE;
  let [low, high, result] = [0, 1, target];
  for (let step = 0; step < 16; step++) {
    const amount = (low + high) / 2;
    const candidate = { r: Math.round(solid.r + (target.r - solid.r) * amount), g: Math.round(solid.g + (target.g - solid.g) * amount), b: Math.round(solid.b + (target.b - solid.b) * amount), a: 1 };
    if (ratio(candidate, surface) >= AA_TEXT + 0.1) [result, high] = [candidate, amount];
    else low = amount;
  }
  return result;
};

/**
 * The WCAG contrast of text `foreground` on `background`, each laid over what is under it first (`canvas`, then the
 * background): a translucent selection is measured as it shows. Null when a color is not one `parseColor` reads.
 */
export const contrastRatio = (foreground: string, background: string, canvas = '#ffffff'): number | null => {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  const under = parseColor(canvas);
  if (!fg || !bg || !under) return null;
  const surface = over(bg, over(under, WHITE));
  return ratio(over(fg, surface), surface);
};

// The mapping --------------------------------------------------------------------------------------------------------

type ColorToken = Exclude<keyof HostThemeTokens, 'font' | 'mono' | 'radius'>;

/**
 * How one VS Code color comes from OpenChamber's tokens: a token as it is; `[token, alpha]`, that token faded (its
 * alpha times `alpha`); `[token, alpha, under]`, that token at `alpha` painted over another token (a solid mix); or
 * `{ shade, from, by }`, the solid `shade` moved by `by` toward black or white, whichever is further from the token
 * `from` (a pressed or hovered fill that keeps its text, `from`, at least as readable); or `{ text, on }`, the token
 * `text` made readable on the token `on`, as the code colors are (`readableOn`).
 */
export type ColorRecipe =
  | ColorToken
  | readonly [ColorToken, number]
  | readonly [ColorToken, number, ColorToken]
  | { readonly shade: ColorToken; readonly from: ColorToken; readonly by: number }
  | { readonly text: ColorToken; readonly on: ColorToken };

/**
 * VS Code's workbench colors (`workbench.colorCustomizations` keys) and the token each is. Each frame's main surface
 * is `background`, the color OpenChamber paints around that frame (the chat, a docked panel); floating and input
 * surfaces are `elevated`, as in OpenChamber, which shares that color between fields and floating UI; selections,
 * hovers and pressed states are OpenChamber's own; accents are `primary`, and text on a neutral surface in an accent
 * color is its readable `*Text` form.
 */
export const COLOR_RECIPES: Readonly<Record<string, ColorRecipe>> = {
  // Text, icons, links, focus.
  foreground: 'foreground',
  descriptionForeground: 'muted',
  disabledForeground: ['muted', 0.6],
  errorForeground: 'errorText',
  'icon.foreground': 'muted',
  // OpenChamber's focus color is a translucent ring a few pixels wide; VS Code's focus border is a 1 px outline, which
  // needs the solid accent to show.
  focusBorder: 'primary',
  'selection.background': 'selection',
  'textLink.foreground': 'primaryText',
  'textLink.activeForeground': 'primaryText',
  'textBlockQuote.background': 'subtle',
  'textBlockQuote.border': 'border',
  'textCodeBlock.background': 'subtle',
  'textPreformat.background': 'subtle',
  'textPreformat.foreground': 'foreground',
  'textSeparator.foreground': 'border',
  'widget.border': 'border',
  'sash.hoverBorder': 'primary',
  'progressBar.background': 'primary',
  'toolbar.hoverBackground': 'hover',
  'toolbar.activeBackground': 'active',
  'actionBar.toggledBackground': 'active',
  'scrollbarSlider.background': ['foreground', 0.18],
  'scrollbarSlider.hoverBackground': ['foreground', 0.36],
  'scrollbarSlider.activeBackground': ['foreground', 0.45],
  'minimapSlider.background': ['foreground', 0.18],
  'minimapSlider.hoverBackground': ['foreground', 0.36],
  'minimapSlider.activeBackground': ['foreground', 0.45],

  // The editor.
  'editor.background': 'background',
  'editor.foreground': 'foreground',
  'editorGutter.background': 'background',
  'editorCursor.foreground': 'foreground',
  'editorLineNumber.foreground': 'muted',
  'editorLineNumber.activeForeground': 'foreground',
  // OpenChamber's Files view marks the line the cursor is on with 5% of the text color.
  'editor.lineHighlightBackground': ['foreground', 0.05],
  'editor.selectionBackground': 'selection',
  'editor.inactiveSelectionBackground': ['selection', 0.6],
  'editor.selectionHighlightBackground': ['selection', 0.5],
  'editor.wordHighlightBackground': ['selection', 0.5],
  'editor.wordHighlightStrongBackground': ['selection', 0.7],
  'editor.findMatchBackground': ['primary', 0.3],
  'editor.findMatchHighlightBackground': ['primary', 0.15],
  'editor.findRangeHighlightBackground': 'hover',
  'editor.hoverHighlightBackground': 'hover',
  'editor.rangeHighlightBackground': 'hover',
  // OpenChamber's Files view gives brackets the color of the rest of the punctuation, whatever their depth.
  'editorBracketHighlight.foreground1': { text: 'syntaxComment', on: 'background' },
  'editorBracketHighlight.foreground2': { text: 'syntaxComment', on: 'background' },
  'editorBracketHighlight.foreground3': { text: 'syntaxComment', on: 'background' },
  'editorBracketHighlight.foreground4': { text: 'syntaxComment', on: 'background' },
  'editorBracketHighlight.foreground5': { text: 'syntaxComment', on: 'background' },
  'editorBracketHighlight.foreground6': { text: 'syntaxComment', on: 'background' },
  'editorBracketHighlight.unexpectedBracket.foreground': 'errorText',
  'editorBracketMatch.background': ['primary', 0.15],
  'editorBracketMatch.border': ['primary', 0.4],
  'editorIndentGuide.background1': 'border',
  'editorIndentGuide.activeBackground1': ['muted', 0.5],
  'editorRuler.foreground': 'border',
  'editorWhitespace.foreground': ['muted', 0.4],
  'editorCodeLens.foreground': 'muted',
  'editorLink.activeForeground': 'primaryText',
  'editorOverviewRuler.border': 'border',
  'editorStickyScroll.background': 'background',
  'editorStickyScrollHover.background': ['hover', 1, 'background'],
  'editorStickyScroll.border': 'border',
  'editorError.foreground': 'error',
  'editorWarning.foreground': 'warning',
  'editorInfo.foreground': 'info',
  'editorGutter.addedBackground': 'success',
  'editorGutter.modifiedBackground': 'info',
  'editorGutter.deletedBackground': 'error',
  'editorOverviewRuler.addedForeground': 'success',
  'editorOverviewRuler.modifiedForeground': 'info',
  'editorOverviewRuler.deletedForeground': 'error',
  'editorOverviewRuler.errorForeground': 'error',
  'editorOverviewRuler.warningForeground': 'warning',
  'diffEditor.insertedTextBackground': ['success', 0.2],
  'diffEditor.removedTextBackground': ['error', 0.2],
  'diffEditor.insertedLineBackground': ['success', 0.1],
  'diffEditor.removedLineBackground': ['error', 0.1],
  'editorWidget.background': 'elevated',
  'editorWidget.foreground': 'elevatedForeground',
  'editorWidget.border': 'border',
  'editorSuggestWidget.background': 'elevated',
  'editorSuggestWidget.foreground': 'elevatedForeground',
  'editorSuggestWidget.border': 'border',
  'editorSuggestWidget.selectedBackground': 'selection',
  'editorSuggestWidget.selectedForeground': 'selectionForeground',
  'editorSuggestWidget.selectedIconForeground': 'selectionForeground',
  'editorSuggestWidget.highlightForeground': 'primaryText',
  // On a selected row the match is in the row's own text color, bold as VS Code draws a match.
  'editorSuggestWidget.focusHighlightForeground': 'selectionForeground',
  'editorHoverWidget.background': 'elevated',
  'editorHoverWidget.foreground': 'elevatedForeground',
  'editorHoverWidget.border': 'border',
  'peekView.border': 'primary',
  'peekViewEditor.background': 'mutedSurface',
  'peekViewEditor.matchHighlightBackground': ['primary', 0.2],
  'peekViewResult.background': 'elevated',
  'peekViewResult.fileForeground': 'elevatedForeground',
  'peekViewResult.lineForeground': 'muted',
  'peekViewResult.matchHighlightBackground': ['primary', 0.2],
  'peekViewResult.selectionBackground': 'selection',
  'peekViewResult.selectionForeground': 'selectionForeground',
  'peekViewTitle.background': 'elevated',
  'peekViewTitleLabel.foreground': 'elevatedForeground',
  'peekViewTitleDescription.foreground': 'muted',
  'breadcrumb.background': 'background',
  'breadcrumb.foreground': 'muted',
  'breadcrumb.focusForeground': 'foreground',
  'breadcrumb.activeSelectionForeground': 'foreground',
  'breadcrumbPicker.background': 'elevated',

  // Editor tabs (the page keeps VS Code's own tab bar when OpenChamber's header has no tabs, and the whole workbench).
  'editorGroup.border': 'border',
  'editorGroupHeader.tabsBackground': 'mutedSurface',
  'editorGroupHeader.tabsBorder': 'border',
  'editorGroupHeader.noTabsBackground': 'background',
  'tab.activeBackground': 'background',
  'tab.activeForeground': 'foreground',
  'tab.activeBorder': 'background',
  'tab.activeBorderTop': 'primary',
  'tab.inactiveBackground': 'mutedSurface',
  'tab.inactiveForeground': 'muted',
  'tab.hoverBackground': 'background',
  'tab.hoverForeground': 'foreground',
  'tab.border': 'border',
  'tab.lastPinnedBorder': 'border',
  'tab.unfocusedActiveBackground': 'background',
  'tab.unfocusedActiveForeground': 'muted',
  'tab.unfocusedActiveBorderTop': 'border',
  'tab.unfocusedInactiveBackground': 'mutedSurface',
  'tab.unfocusedInactiveForeground': 'muted',

  // The side bar (a rail view), the panel and the terminal (OpenChamber's bottom).
  'sideBar.background': 'background',
  'sideBar.foreground': 'foreground',
  'sideBar.border': 'border',
  'sideBarTitle.foreground': 'foreground',
  'sideBarSectionHeader.background': 'background',
  'sideBarSectionHeader.foreground': 'foreground',
  'sideBarSectionHeader.border': 'border',
  'sideBarStickyScroll.background': 'background',
  'panel.background': 'background',
  'panel.border': 'border',
  'panelTitle.activeForeground': 'foreground',
  'panelTitle.inactiveForeground': 'muted',
  'panelTitle.activeBorder': 'primary',
  'panelSection.border': 'border',
  'panelSectionHeader.border': 'border',
  'panelInput.border': 'border',
  'panelStickyScroll.background': 'background',
  'terminal.background': 'background',
  'terminal.foreground': 'foreground',
  'terminal.border': 'border',
  'terminal.selectionBackground': 'selection',
  'terminal.inactiveSelectionBackground': ['selection', 0.5],
  'terminal.tab.activeBorder': 'primary',
  'terminalCursor.foreground': 'foreground',
  'terminalCursor.background': 'background',
  // The colors OpenChamber's own terminal gives the 16 ANSI colors (its `convertThemeToXterm`); VS Code's minimum
  // contrast (`terminal.integrated.minimumContrastRatio`) keeps the text in them readable, as it does for any theme.
  'terminal.ansiBlack': 'mutedSurface',
  'terminal.ansiRed': 'error',
  'terminal.ansiGreen': 'success',
  'terminal.ansiYellow': 'warning',
  'terminal.ansiBlue': 'syntaxFunction',
  'terminal.ansiMagenta': 'syntaxKeyword',
  'terminal.ansiCyan': 'syntaxType',
  'terminal.ansiWhite': 'foreground',
  'terminal.ansiBrightBlack': 'syntaxComment',
  'terminal.ansiBrightRed': 'error',
  'terminal.ansiBrightGreen': 'success',
  'terminal.ansiBrightYellow': 'warning',
  'terminal.ansiBrightBlue': 'syntaxFunction',
  'terminal.ansiBrightMagenta': 'syntaxKeyword',
  'terminal.ansiBrightCyan': 'syntaxType',
  'terminal.ansiBrightWhite': 'elevatedForeground',

  // The title, status and activity bars, where a frame shows them (the page, the whole workbench).
  'titleBar.activeBackground': 'background',
  'titleBar.activeForeground': 'foreground',
  'titleBar.inactiveBackground': 'background',
  'titleBar.inactiveForeground': 'muted',
  'titleBar.border': 'border',
  'commandCenter.background': 'elevated',
  'commandCenter.foreground': 'foreground',
  'commandCenter.activeBackground': 'hover',
  'commandCenter.activeForeground': 'foreground',
  'commandCenter.border': 'border',
  'commandCenter.activeBorder': 'border',
  'commandCenter.inactiveForeground': 'muted',
  'commandCenter.inactiveBorder': 'border',
  'menubar.selectionBackground': 'hover',
  'menubar.selectionForeground': 'foreground',
  'statusBar.background': 'background',
  'statusBar.foreground': 'muted',
  'statusBar.border': 'border',
  'statusBar.focusBorder': 'primary',
  'statusBar.noFolderBackground': 'background',
  'statusBar.noFolderForeground': 'muted',
  'statusBar.debuggingBackground': 'primary',
  'statusBar.debuggingForeground': 'primaryForeground',
  'statusBarItem.hoverBackground': 'hover',
  'statusBarItem.hoverForeground': 'foreground',
  'statusBarItem.activeBackground': 'active',
  'statusBarItem.focusBorder': 'primary',
  'statusBarItem.remoteBackground': 'primary',
  'statusBarItem.remoteForeground': 'primaryForeground',
  'statusBarItem.prominentBackground': 'primary',
  'statusBarItem.prominentForeground': 'primaryForeground',
  'statusBarItem.prominentHoverBackground': { shade: 'primary', from: 'primaryForeground', by: 0.1 },
  'activityBar.background': 'mutedSurface',
  'activityBar.foreground': 'foreground',
  'activityBar.inactiveForeground': 'muted',
  'activityBar.border': 'border',
  'activityBar.activeBorder': 'primary',
  'activityBar.activeBackground': 'active',
  'activityBar.activeFocusBorder': 'primary',
  'activityBarBadge.background': 'primary',
  'activityBarBadge.foreground': 'primaryForeground',
  'activityBarTop.foreground': 'foreground',
  'activityBarTop.inactiveForeground': 'muted',
  'activityBarTop.activeBorder': 'primary',

  // Lists and trees: OpenChamber's selection and hover; the keyboard focus in its focus color.
  'list.activeSelectionBackground': 'selection',
  'list.activeSelectionForeground': 'selectionForeground',
  'list.activeSelectionIconForeground': 'selectionForeground',
  'list.inactiveSelectionBackground': 'selection',
  'list.inactiveSelectionForeground': 'selectionForeground',
  'list.focusBackground': 'selection',
  'list.focusForeground': 'selectionForeground',
  'list.focusOutline': 'focus',
  'list.focusAndSelectionOutline': 'focus',
  'list.hoverBackground': 'hover',
  'list.hoverForeground': 'foreground',
  'list.highlightForeground': 'primaryText',
  'list.focusHighlightForeground': 'selectionForeground',
  'list.dropBackground': ['primary', 0.1],
  'list.errorForeground': 'errorText',
  'list.warningForeground': 'warningText',
  'list.invalidItemForeground': 'errorText',
  'listFilterWidget.background': 'elevated',
  'tree.indentGuidesStroke': 'border',

  // Menus, the quick input, notifications: OpenChamber's floating surfaces; a menu marks the item under the pointer
  // with OpenChamber's hover, as OpenChamber's own menus do.
  'menu.background': 'elevated',
  'menu.foreground': 'elevatedForeground',
  'menu.selectionBackground': 'hover',
  'menu.selectionForeground': 'elevatedForeground',
  'menu.selectionBorder': 'hover',
  'menu.separatorBackground': 'border',
  'menu.border': 'border',
  'quickInput.background': 'elevated',
  'quickInput.foreground': 'elevatedForeground',
  'quickInputTitle.background': 'elevated',
  'quickInputList.focusBackground': 'selection',
  'quickInputList.focusForeground': 'selectionForeground',
  'quickInputList.focusIconForeground': 'selectionForeground',
  'quickInputList.focusHighlightForeground': 'selectionForeground',
  'pickerGroup.border': 'border',
  'pickerGroup.foreground': 'muted',
  'keybindingLabel.background': 'subtle',
  'keybindingLabel.foreground': 'foreground',
  'keybindingLabel.border': 'border',
  'keybindingLabel.bottomBorder': 'border',
  'notifications.background': 'elevated',
  'notifications.foreground': 'elevatedForeground',
  'notifications.border': 'border',
  'notificationCenter.border': 'border',
  'notificationCenterHeader.background': 'elevated',
  'notificationCenterHeader.foreground': 'elevatedForeground',
  'notificationToast.border': 'border',
  'notificationLink.foreground': 'primaryText',
  'notificationsErrorIcon.foreground': 'error',
  'notificationsWarningIcon.foreground': 'warning',
  'notificationsInfoIcon.foreground': 'info',

  // Inputs, dropdowns, checkboxes, buttons, badges.
  'input.background': 'elevated',
  'input.foreground': 'elevatedForeground',
  'input.border': 'border',
  'input.placeholderForeground': 'muted',
  'inputOption.activeBackground': 'active',
  'inputOption.activeForeground': 'foreground',
  'inputOption.activeBorder': 'border',
  'inputOption.hoverBackground': 'hover',
  'inputValidation.infoBackground': 'elevated',
  'inputValidation.infoForeground': 'elevatedForeground',
  'inputValidation.infoBorder': 'info',
  'inputValidation.warningBackground': 'elevated',
  'inputValidation.warningForeground': 'elevatedForeground',
  'inputValidation.warningBorder': 'warning',
  'inputValidation.errorBackground': 'elevated',
  'inputValidation.errorForeground': 'elevatedForeground',
  'inputValidation.errorBorder': 'error',
  'dropdown.background': 'elevated',
  'dropdown.foreground': 'elevatedForeground',
  'dropdown.border': 'border',
  'dropdown.listBackground': 'elevated',
  'checkbox.background': 'elevated',
  'checkbox.foreground': 'elevatedForeground',
  'checkbox.border': 'border',
  'button.background': 'primary',
  'button.foreground': 'primaryForeground',
  'button.hoverBackground': { shade: 'primary', from: 'primaryForeground', by: 0.1 },
  'button.border': 'primary',
  'button.separator': ['primaryForeground', 0.4],
  'button.secondaryBackground': 'elevated',
  'button.secondaryForeground': 'elevatedForeground',
  'button.secondaryHoverBackground': ['hover', 1, 'elevated'],
  'button.secondaryBorder': 'border',
  'badge.background': 'primary',
  'badge.foreground': 'primaryForeground',
  'extensionButton.prominentBackground': 'primary',
  'extensionButton.prominentForeground': 'primaryForeground',
  'extensionButton.prominentHoverBackground': { shade: 'primary', from: 'primaryForeground', by: 0.1 },
  'extensionBadge.remoteBackground': 'primary',
  'extensionBadge.remoteForeground': 'primaryForeground',

  // The settings editor.
  'settings.headerForeground': 'foreground',
  'settings.modifiedItemIndicator': 'primary',
  'settings.dropdownBackground': 'elevated',
  'settings.dropdownForeground': 'elevatedForeground',
  'settings.dropdownBorder': 'border',
  'settings.dropdownListBorder': 'border',
  'settings.checkboxBackground': 'elevated',
  'settings.checkboxForeground': 'elevatedForeground',
  'settings.checkboxBorder': 'border',
  'settings.textInputBackground': 'elevated',
  'settings.textInputForeground': 'elevatedForeground',
  'settings.textInputBorder': 'border',
  'settings.numberInputBackground': 'elevated',
  'settings.numberInputForeground': 'elevatedForeground',
  'settings.numberInputBorder': 'border',
  'settings.rowHoverBackground': 'hover',
  'settings.focusedRowBackground': 'hover',
  'settings.focusedRowBorder': 'focus',

  // Source control, problems, tests: OpenChamber's status colors, as text where they are text.
  'gitDecoration.addedResourceForeground': 'successText',
  'gitDecoration.untrackedResourceForeground': 'successText',
  'gitDecoration.modifiedResourceForeground': 'infoText',
  'gitDecoration.stageModifiedResourceForeground': 'infoText',
  'gitDecoration.deletedResourceForeground': 'errorText',
  'gitDecoration.stageDeletedResourceForeground': 'errorText',
  'gitDecoration.conflictingResourceForeground': 'warningText',
  'gitDecoration.ignoredResourceForeground': 'muted',
  'problemsErrorIcon.foreground': 'error',
  'problemsWarningIcon.foreground': 'warning',
  'problemsInfoIcon.foreground': 'info',
  'testing.iconPassed': 'success',
  'testing.iconFailed': 'error',
};

/** The tokens a recipe reads. */
export const recipeTokens = (recipe: ColorRecipe): ColorToken[] => {
  if (typeof recipe === 'string') return [recipe];
  if ('shade' in recipe) return [recipe.shade, recipe.from];
  if ('text' in recipe) return [recipe.text, recipe.on];
  return recipe.length === 3 ? [recipe[0], recipe[2]] : [recipe[0]];
};

const tokenColor = (tokens: HostThemeTokens, name: ColorToken): Rgba | null => {
  const value = tokens[name];
  return typeof value === 'string' ? parseColor(value) : null;
};

/** One recipe's color, or null when a token it needs is missing or is not a color `parseColor` reads. */
export const colorOf = (recipe: ColorRecipe, tokens: HostThemeTokens): string | null => {
  if (typeof recipe !== 'string' && 'text' in recipe) {
    const text = tokenColor(tokens, recipe.text);
    const surface = tokenColor(tokens, recipe.on);
    return text && surface ? hexOf(readableOn(text, over(surface, WHITE))) : null;
  }
  if (typeof recipe !== 'string' && 'shade' in recipe) {
    const fill = tokenColor(tokens, recipe.shade);
    const text = tokenColor(tokens, recipe.from);
    if (!fill || !text) return null;
    const solid = over(fill, WHITE);
    const toward = { ...(luminance(over(text, solid)) > luminance(solid) ? BLACK : WHITE), a: recipe.by };
    return hexOf(over(toward, solid));
  }
  const [name, alpha = 1, under] = typeof recipe === 'string' ? [recipe] : recipe;
  const color = tokenColor(tokens, name);
  if (!color) return null;
  const faded = { ...color, a: color.a * alpha };
  if (!under) return hexOf(faded);
  const base = tokenColor(tokens, under);
  return base ? hexOf(over(faded, base)) : null;
};

/** OpenChamber's workbench colors as VS Code's: every key of `COLOR_RECIPES` whose tokens OpenChamber gave. */
export const vscodeColors = (tokens: HostThemeTokens): Record<string, string> => {
  const colors: Record<string, string> = {};
  for (const [key, recipe] of Object.entries(COLOR_RECIPES)) {
    const color = colorOf(recipe, tokens);
    if (color) colors[key] = color;
  }
  return colors;
};

/** VS Code's own groups of `editor.tokenColorCustomizations` ("comments", …), which a user may set instead of rules. */
export type TokenGroup = 'comments' | 'strings' | 'keywords' | 'numbers' | 'types' | 'functions' | 'variables';
export const TOKEN_GROUPS: readonly TokenGroup[] = ['comments', 'strings', 'keywords', 'numbers', 'types', 'functions', 'variables'];

type SyntaxToken = 'syntaxComment' | 'syntaxString' | 'syntaxNumber' | 'syntaxKeyword' | 'syntaxOperator' | 'syntaxFunction' | 'syntaxType' | 'syntaxVariable';

/**
 * Code colors as OpenChamber's Files view paints them (its CodeMirror highlight style with the theme's base syntax
 * colors): which TextMate scopes take which token. Brackets and other punctuation take the comment color there,
 * quotes the string's, `this` and literals like `true` the number's, tags and headings the keyword's, properties and
 * attributes the variable's. The scopes are as specific as the default themes' own rules they replace (a more
 * specific rule of the theme would win), and they include the scopes VS Code styles a language server's semantic
 * tokens with (`variable.other.readwrite`, `variable.other.constant`, `entity.name.function.member`, …), so semantic
 * highlighting lands on the same colors. Each color is made readable on the editor's background (`readableOn`):
 * many of OpenChamber's themes give some code colors less than AA contrast, comments most often. `group`: VS Code's
 * group of the same name (`editor.tokenColorCustomizations.comments`, …), which takes these scopes over when the
 * user sets it.
 */
export const SYNTAX_RULES: readonly { kind: string; token: SyntaxToken; group?: TokenGroup; scopes: readonly string[] }[] = [
  { kind: 'punctuation', token: 'syntaxComment', scopes: ['punctuation', 'meta.brace', 'punctuation.separator', 'punctuation.terminator', 'punctuation.accessor'] },
  { kind: 'comment', token: 'syntaxComment', group: 'comments', scopes: ['comment', 'punctuation.definition.comment', 'string.comment'] },
  { kind: 'string', token: 'syntaxString', group: 'strings', scopes: ['string', 'punctuation.definition.string', 'string.regexp', 'constant.character.escape', 'markup.inline.raw', 'string.other.link'] },
  { kind: 'number', token: 'syntaxNumber', group: 'numbers', scopes: ['constant.numeric', 'constant.language', 'variable.language.this', 'variable.language.self', 'variable.language.super'] },
  {
    kind: 'keyword',
    token: 'syntaxKeyword',
    group: 'keywords',
    scopes: ['keyword', 'keyword.control', 'keyword.other', 'storage', 'storage.type', 'storage.modifier', 'entity.name.tag', 'support.class.component', 'markup.heading', 'entity.name.section', 'punctuation.definition.heading'],
  },
  { kind: 'operator', token: 'syntaxOperator', scopes: ['keyword.operator', 'storage.type.function.arrow'] },
  { kind: 'function', token: 'syntaxFunction', group: 'functions', scopes: ['entity.name.function', 'support.function', 'meta.function-call.generic', 'variable.function', 'markup.underline.link'] },
  {
    kind: 'type',
    token: 'syntaxType',
    group: 'types',
    scopes: ['entity.name.type', 'entity.name.class', 'entity.name.namespace', 'entity.other.inherited-class', 'support.type', 'support.class', 'storage.type.primitive'],
  },
  {
    kind: 'variable',
    token: 'syntaxVariable',
    group: 'variables',
    scopes: [
      'variable',
      'variable.other',
      'variable.other.readwrite',
      'variable.other.constant',
      'variable.other.property',
      'variable.other.object',
      'variable.other.enummember',
      'variable.parameter',
      'meta.definition.variable',
      'entity.name.variable',
      'entity.name.constant',
      'support.variable',
      'support.constant',
      'meta.object-literal.key',
      'support.type.property-name',
      'meta.property-name',
      'entity.other.attribute-name',
    ],
  },
];

export interface TextMateRule {
  name?: string;
  scope: string | string[];
  settings: Record<string, unknown>;
}

/** OpenChamber's code-color rules, each with the group of VS Code's that a user's setting of it takes over. */
const syntaxRules = (tokens: HostThemeTokens): { group?: TokenGroup; rule: TextMateRule }[] => {
  const rules: { group?: TokenGroup; rule: TextMateRule }[] = [];
  const background = parseColor(tokens.background);
  if (!background) return rules;
  const surface = over(background, WHITE);
  for (const { kind, token, group, scopes } of SYNTAX_RULES) {
    const value = tokens[token];
    const color = typeof value === 'string' ? parseColor(value) : null;
    if (!color) continue;
    const rule: TextMateRule = { name: `OpenChamber ${kind}`, scope: [...scopes], settings: { foreground: hexOf(readableOn(color, surface)) } };
    rules.push(group ? { group, rule } : { rule });
  }
  return rules;
};

/** OpenChamber's code colors as one theme's `editor.tokenColorCustomizations`, or null when it gave none. */
export const vscodeTokenColors = (tokens: HostThemeTokens): { textMateRules: TextMateRule[] } | null => {
  const rules = syntaxRules(tokens);
  return rules.length ? { textMateRules: rules.map(({ rule }) => rule) } : null;
};

/** A CSS font-family list as VS Code's font settings take it; null when it is not a plausible one. */
const fontFamily = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' && value.length <= 512 && !/[;{}<>\\]/.test(value) ? value.trim() : null;

/**
 * OpenChamber's fonts: its monospace one is the editor's, and so the terminal's and the debug console's (theirs
 * follow the editor's unless the user set them); its interface font is the Markdown preview's, prose as in a chat.
 * VS Code's own interface font is not a setting.
 */
export const fontSettings = (tokens: HostThemeTokens): Record<string, string> => {
  const settings: Record<string, string> = {};
  const mono = fontFamily(tokens.mono);
  const sans = fontFamily(tokens.font);
  if (mono) settings['editor.fontFamily'] = mono;
  if (sans) settings['markdown.preview.fontFamily'] = sans;
  return settings;
};

export const COLOR_SETTING = 'workbench.colorCustomizations';
export const TOKEN_SETTING = 'editor.tokenColorCustomizations';
export const FONT_SETTINGS = ['editor.fontFamily', 'markdown.preview.fontFamily'] as const;

/**
 * OpenChamber's look as VS Code settings, for the default theme of its mode: the colors and code colors under that
 * theme's scope, and the fonts. The frame gives them to VS Code as its defaults as it starts.
 */
export const lookSettings = (theme: HostTheme): Record<string, unknown> => {
  const scope = themeScope(DEFAULT_THEMES[modeOfTheme(theme)]);
  const settings: Record<string, unknown> = { [COLOR_SETTING]: { [scope]: vscodeColors(theme.tokens) } };
  const tokenColors = vscodeTokenColors(theme.tokens);
  if (tokenColors) settings[TOKEN_SETTING] = { [scope]: tokenColors };
  return { ...settings, ...fontSettings(theme.tokens) };
};

// Precedence ---------------------------------------------------------------------------------------------------------

type Settings = Record<string, unknown>;

const isRecord = (value: unknown): value is Settings => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A theme id in a scope key matches a theme as VS Code matches it: exactly, or with `*` at either end or both. */
const themeIdMatches = (id: string, name: string): boolean => {
  const first = id.charAt(0);
  const last = id.charAt(id.length - 1);
  return id === name
    || (first === '*' && last === '*' && name.includes(id.slice(1, -1)))
    || (last === '*' && name.startsWith(id.slice(0, -1)))
    || (first === '*' && name.endsWith(id.slice(1)));
};

const isScopeKey = (key: string): boolean => key.startsWith('[') && key.endsWith(']');

/** Whether a key like `[Light 2026]` or `[Abyss][*Light*]` applies to the theme `name`. */
export const scopeApplies = (key: string, name: string): boolean =>
  isScopeKey(key) && [...key.matchAll(/\[(.+?)\]/g)].some((match) => themeIdMatches(match[1] ?? '', name));

/**
 * What the user's own customizations say for one theme, from their layers of a setting (lowest first): the keys
 * outside any theme scope, and those under the scopes that apply to the theme, each merged the way VS Code merges
 * them (a later value wins; rule lists add up).
 */
const userCustomizations = (layers: readonly unknown[], name: string): { general: Settings; scoped: Settings } => {
  const general: Settings = {};
  const scoped: Settings = {};
  const add = (into: Settings, key: string, value: unknown) => {
    const before = into[key];
    if (Array.isArray(before) && Array.isArray(value)) into[key] = [...before, ...value];
    else if (value !== undefined && value !== null) into[key] = value;
  };
  for (const layer of layers) {
    if (!isRecord(layer)) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (!isScopeKey(key)) add(general, key, value);
      else if (isRecord(value) && scopeApplies(key, name)) for (const [subkey, subvalue] of Object.entries(value)) add(scoped, subkey, subvalue);
    }
  }
  return { general, scoped };
};

/** One setting as VS Code's configuration service inspects it, as far as the precedence needs. */
export interface InspectedSetting {
  defaultValue?: unknown;
  applicationValue?: unknown;
  userValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

/** The user's own layers of a setting, lowest first: application, user (local and remote), workspace, folder. */
export const userLayers = (inspected: InspectedSetting): unknown[] =>
  [inspected.applicationValue, inspected.userValue, inspected.workspaceValue, inspected.workspaceFolderValue].filter((value) => value !== undefined);

const scopeOf = (value: unknown, scope: string): Settings => (isRecord(value) && isRecord(value[scope]) ? value[scope] : {});
const rulesOf = (value: unknown): TextMateRule[] => (Array.isArray(value) ? (value as TextMateRule[]) : []);

/** Two values the same as settings (plain JSON). */
export const sameSetting = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * OpenChamber's look as the frame keeps it in VS Code's memory configuration (`ConfigurationTarget.MEMORY`, above
 * every other layer and never written anywhere) once VS Code runs, for the theme OpenChamber shows now (`current`)
 * and the last one it showed in the other mode, each under its default theme's scope: VS Code keeps the colors of the
 * theme it is leaving until the other has loaded. For each setting, what makes VS Code show the look as if it were
 * the default theme's own colors, with the user's customizations on top as on any theme:
 *   - a font, OpenChamber's now: unless the user set one (then none: theirs shows);
 *   - a color under a theme's scope: the user's for that theme if they set one, else theirs for every theme, else
 *     OpenChamber's; a color the defaults still hold from the look VS Code started with and this one lacks: the
 *     user's, or `null`, which leaves the theme's own;
 *   - code colors: OpenChamber's rules without those of a group (comments, strings, …) the user set, then the user's
 *     own rules for every theme and for this one, which come later and so win.
 * A setting `undefined` here has nothing in memory.
 */
export const lookInMemory = (current: HostTheme, inspect: (key: string) => InspectedSetting, other?: HostTheme): Settings => {
  const themes = other && modeOfTheme(other) !== modeOfTheme(current) ? [other, current] : [current];
  const memory: Settings = {};
  const fonts = fontSettings(current.tokens);
  for (const key of FONT_SETTINGS) {
    const inspected = inspect(key);
    const ours = fonts[key];
    memory[key] = ours !== undefined && userLayers(inspected).length === 0 && ours !== inspected.defaultValue ? ours : undefined;
  }

  const colorSetting = inspect(COLOR_SETTING);
  const tokenSetting = inspect(TOKEN_SETTING);
  const colors: Settings = {};
  const tokenColors: Settings = {};
  for (const theme of themes) {
    const name = DEFAULT_THEMES[modeOfTheme(theme)];
    const scope = themeScope(name);

    const user = userCustomizations(userLayers(colorSetting), name);
    const ours: Settings = vscodeColors(theme.tokens);
    const resolved: Settings = {};
    for (const key of new Set([...Object.keys(ours), ...Object.keys(scopeOf(colorSetting.defaultValue, scope))])) {
      resolved[key] = user.scoped[key] ?? user.general[key] ?? ours[key] ?? null;
    }
    if (Object.keys(resolved).length) colors[scope] = resolved;

    const userTokens = userCustomizations(userLayers(tokenSetting), name);
    const taken = new Set(TOKEN_GROUPS.filter((group) => userTokens.scoped[group] || userTokens.general[group]));
    const textMateRules = [
      ...syntaxRules(theme.tokens).filter(({ group }) => !group || !taken.has(group)).map(({ rule }) => rule),
      ...rulesOf(userTokens.general.textMateRules),
      ...rulesOf(userTokens.scoped.textMateRules),
    ];
    if (textMateRules.length || 'textMateRules' in scopeOf(tokenSetting.defaultValue, scope)) tokenColors[scope] = { textMateRules };
  }
  memory[COLOR_SETTING] = Object.keys(colors).length ? colors : undefined;
  memory[TOKEN_SETTING] = Object.keys(tokenColors).length ? tokenColors : undefined;
  return memory;
};
