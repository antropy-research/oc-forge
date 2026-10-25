// VS Code's language configuration files (language-configuration.json) as
// Monaco's LanguageConfiguration: the same fields, with the regular
// expressions VS Code writes as strings turned into RegExps. Pure.

type RegexSource = string | { pattern: string; flags?: string };

/** Monaco's IndentAction: None, Indent, IndentOutdent, Outdent. */
const INDENT_ACTIONS: Record<string, number> = { none: 0, indent: 1, indentOutdent: 2, outdent: 3 };

const regex = (value: unknown): RegExp | undefined => {
  if (typeof value === 'string') return safeRegex(value, '');
  if (value && typeof value === 'object' && typeof (value as { pattern?: unknown }).pattern === 'string') {
    const source = value as { pattern: string; flags?: string };
    return safeRegex(source.pattern, source.flags ?? '');
  }
  return undefined;
};

/** VS Code's patterns are Oniguruma-flavored here and there; one JavaScript does not take is left out. */
const safeRegex = (pattern: string, flags: string): RegExp | undefined => {
  try {
    return new RegExp(pattern, flags.replace(/[^dgimsuyv]/g, ''));
  } catch {
    return undefined;
  }
};

const pairs = (value: unknown): { open: string; close: string; notIn?: string[] }[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string') return [{ open: item[0], close: item[1] }];
    if (item && typeof item === 'object' && typeof item.open === 'string' && typeof item.close === 'string') {
      return [{ open: item.open, close: item.close, ...(Array.isArray(item.notIn) ? { notIn: item.notIn.filter((entry: unknown) => typeof entry === 'string') } : {}) }];
    }
    return [];
  });
};

/** Monaco's LanguageConfiguration, as far as VS Code's file sets it. */
export interface MonacoLanguageConfiguration {
  comments?: { lineComment?: string; blockComment?: [string, string] };
  brackets?: [string, string][];
  autoClosingPairs?: { open: string; close: string; notIn?: string[] }[];
  surroundingPairs?: { open: string; close: string }[];
  autoCloseBefore?: string;
  wordPattern?: RegExp;
  indentationRules?: { increaseIndentPattern: RegExp; decreaseIndentPattern: RegExp; indentNextLinePattern?: RegExp; unIndentedLinePattern?: RegExp };
  onEnterRules?: { beforeText: RegExp; afterText?: RegExp; previousLineText?: RegExp; action: { indentAction: number; appendText?: string; removeText?: number } }[];
  folding?: { offSide?: boolean; markers?: { start: RegExp; end: RegExp } };
}

export const toMonacoConfiguration = (raw: unknown): MonacoLanguageConfiguration => {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const config: MonacoLanguageConfiguration = {};
  const comments = source.comments as { lineComment?: unknown; blockComment?: unknown } | undefined;
  if (comments) {
    const line = typeof comments.lineComment === 'string' ? comments.lineComment : (comments.lineComment as { comment?: unknown } | undefined)?.comment;
    const block = Array.isArray(comments.blockComment) && comments.blockComment.length === 2 && comments.blockComment.every((item) => typeof item === 'string') ? (comments.blockComment as [string, string]) : undefined;
    config.comments = { ...(typeof line === 'string' ? { lineComment: line } : {}), ...(block ? { blockComment: block } : {}) };
  }
  if (Array.isArray(source.brackets)) config.brackets = source.brackets.filter((item): item is [string, string] => Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string');
  const closing = pairs(source.autoClosingPairs);
  if (closing) config.autoClosingPairs = closing;
  const surrounding = pairs(source.surroundingPairs);
  if (surrounding) config.surroundingPairs = surrounding.map(({ open, close }) => ({ open, close }));
  if (typeof source.autoCloseBefore === 'string') config.autoCloseBefore = source.autoCloseBefore;
  const word = regex(source.wordPattern as RegexSource | undefined);
  if (word) config.wordPattern = word;
  const indentation = source.indentationRules as Record<string, unknown> | undefined;
  if (indentation) {
    const increase = regex(indentation.increaseIndentPattern);
    const decrease = regex(indentation.decreaseIndentPattern);
    if (increase && decrease) {
      const next = regex(indentation.indentNextLinePattern);
      const unindented = regex(indentation.unIndentedLinePattern);
      config.indentationRules = { increaseIndentPattern: increase, decreaseIndentPattern: decrease, ...(next ? { indentNextLinePattern: next } : {}), ...(unindented ? { unIndentedLinePattern: unindented } : {}) };
    }
  }
  if (Array.isArray(source.onEnterRules)) {
    config.onEnterRules = source.onEnterRules.flatMap((rule: Record<string, unknown>) => {
      const beforeText = regex(rule.beforeText);
      const action = rule.action as { indent?: string; appendText?: string; removeText?: number } | undefined;
      if (!beforeText || !action) return [];
      const afterText = regex(rule.afterText);
      const previousLineText = regex(rule.previousLineText);
      return [{
        beforeText,
        ...(afterText ? { afterText } : {}),
        ...(previousLineText ? { previousLineText } : {}),
        action: { indentAction: INDENT_ACTIONS[action.indent ?? 'none'] ?? 0, ...(typeof action.appendText === 'string' ? { appendText: action.appendText } : {}), ...(typeof action.removeText === 'number' ? { removeText: action.removeText } : {}) },
      }];
    });
  }
  const folding = source.folding as { offSide?: unknown; markers?: { start?: unknown; end?: unknown } } | undefined;
  if (folding) {
    const start = regex(folding.markers?.start);
    const end = regex(folding.markers?.end);
    config.folding = { ...(typeof folding.offSide === 'boolean' ? { offSide: folding.offSide } : {}), ...(start && end ? { markers: { start, end } } : {}) };
  }
  return config;
};

// ── Themes ───────────────────────────────────────────────────────────────────

/** The bits of vscode-textmate's token metadata (VS Code's MetadataConsts). */
export const FONT_STYLE_MASK = 0b0000_0000_0000_0000_0111_1000_0000_0000;
export const FOREGROUND_MASK = 0b0000_0000_1111_1111_1000_0000_0000_0000;
export const FONT_STYLE_OFFSET = 11;
export const FOREGROUND_OFFSET = 15;

/** The Monaco token name for a foreground color index and font style bits (italic 1, bold 2, underline 4, strikethrough 8). */
export const tokenName = (metadata: number): string => {
  const foreground = (metadata & FOREGROUND_MASK) >>> FOREGROUND_OFFSET;
  const fontStyle = (metadata & FONT_STYLE_MASK) >>> FONT_STYLE_OFFSET;
  return fontStyle ? `tm${foreground}s${fontStyle}` : `tm${foreground}`;
};

const FONT_STYLE_WORDS: [number, string][] = [[1, 'italic'], [2, 'bold'], [4, 'underline'], [8, 'strikethrough']];

/**
 * Monaco theme rules for every color of a TextMate color map, with each font
 * style: a token is named by its color's place in the map, so Monaco draws the
 * very colors vscode-textmate resolved from the VS Code theme.
 */
export const themeRules = (colorMap: readonly string[]): { token: string; foreground?: string; fontStyle?: string }[] => {
  const rules: { token: string; foreground?: string; fontStyle?: string }[] = [];
  colorMap.forEach((color, index) => {
    if (index === 0 || !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(color)) return;
    const foreground = color.slice(1, 7).toLowerCase();
    for (let style = 0; style < 16; style++) {
      const words = FONT_STYLE_WORDS.filter(([bit]) => style & bit).map(([, word]) => word).join(' ');
      rules.push({ token: style ? `tm${index}s${style}` : `tm${index}`, foreground, ...(words ? { fontStyle: words } : {}) });
    }
  });
  return rules;
};

/** Editor colors Monaco accepts: VS Code's theme colors, as #rgb, #rrggbb or #rrggbbaa. */
export const editorColors = (colors: Record<string, string> | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(colors ?? {}).filter(([, value]) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)));
