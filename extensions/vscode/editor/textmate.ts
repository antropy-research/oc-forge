// Coloring for Monaco the way VS Code colors code: VS Code's own TextMate
// grammars and themes (taken from a compiled VS Code into vscode/), run by
// vscode-textmate on vscode-oniguruma, the libraries VS Code itself uses.
import * as monaco from 'monaco-editor/editor/editor.api.js';
import { INITIAL, Registry, type IGrammar, type IRawGrammar, type IRawTheme, type StateStack } from 'vscode-textmate';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';
import { editorColors, themeRules, tokenName } from '../src/monacoConfig.ts';
import type { VscodeIndex, VscodeThemeFile } from '../src/vscodeData.ts';

/** A line's end state: vscode-textmate's rule stack, which compares by value. */
class TextMateState implements monaco.languages.IState {
  constructor(readonly ruleStack: StateStack) {}

  clone(): TextMateState {
    return new TextMateState(this.ruleStack);
  }

  equals(other: monaco.languages.IState): boolean {
    return other instanceof TextMateState && (other.ruleStack === this.ruleStack || other.ruleStack.equals(this.ruleStack));
  }
}

/** One line tokenizes for at most this long; a pathological line stays plain past it. */
const LINE_TIME_LIMIT_MS = 500;

export class TextMateColors {
  private registry: Registry | null = null;

  constructor(private readonly index: VscodeIndex, private readonly fetchJson: <T>(path: string) => Promise<T>, private readonly wasm: () => Promise<ArrayBuffer>) {}

  private async ensureRegistry(): Promise<Registry> {
    if (this.registry) return this.registry;
    await loadWASM(await this.wasm());
    this.registry = new Registry({
      onigLib: Promise.resolve({ createOnigScanner: (patterns: string[]) => createOnigScanner(patterns), createOnigString: (text: string) => createOnigString(text) }),
      loadGrammar: async (scopeName) => {
        const grammar = this.index.grammars.find((item) => item.scopeName === scopeName);
        return grammar ? this.fetchJson<IRawGrammar>(`vscode/grammars/${grammar.file}`) : null;
      },
      getInjections: (scopeName) => this.index.grammars.filter((item) => item.injectTo.includes(scopeName)).map((item) => item.scopeName),
    });
    return this.registry;
  }

  /**
   * Use a VS Code theme: vscode-textmate resolves each token's color from it,
   * and a Monaco theme of the same name draws those colors. `background`
   * replaces the editor's own, so the editor sits in OpenChamber's page.
   */
  async useTheme(id: string, theme: VscodeThemeFile, background: string | null): Promise<void> {
    const registry = await this.ensureRegistry();
    const colors = editorColors(theme.colors);
    const raw: IRawTheme = {
      name: theme.name ?? id,
      settings: [
        { settings: { foreground: colors['editor.foreground'] ?? (theme.type === 'light' ? '#000000' : '#d4d4d4'), background: colors['editor.background'] ?? (theme.type === 'light' ? '#ffffff' : '#1e1e1e') } },
        ...(theme.tokenColors ?? []).map((rule) => ({ ...(rule.name ? { name: rule.name } : {}), ...(rule.scope ? { scope: rule.scope } : {}), settings: rule.settings })),
      ],
    };
    registry.setTheme(raw);
    const colorMap = registry.getColorMap();
    if (background) Object.assign(colors, { 'editor.background': background, 'editorGutter.background': background, 'minimap.background': background, 'editorStickyScroll.background': background });
    monaco.editor.defineTheme(id, { base: theme.type === 'light' ? 'vs' : 'vs-dark', inherit: true, rules: [{ token: '', foreground: (colorMap[1] ?? '#d4d4d4').slice(1, 7) }, ...themeRules(colorMap)], colors });
    monaco.editor.setTheme(id);
  }

  /** Color `languageId` with the grammar for `scopeName`; false when there is none. */
  async colorLanguage(languageId: string, scopeName: string): Promise<boolean> {
    const registry = await this.ensureRegistry();
    let grammar: IGrammar | null;
    try {
      grammar = await registry.loadGrammar(scopeName);
    } catch (error) {
      console.warn(`[vscode] the grammar ${scopeName} did not load: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (!grammar) return false;
    const loaded = grammar;
    monaco.languages.setTokensProvider(languageId, {
      getInitialState: () => new TextMateState(INITIAL),
      tokenize: (line: string, state: monaco.languages.IState) => {
        const result = loaded.tokenizeLine2(line, (state as TextMateState).ruleStack, LINE_TIME_LIMIT_MS);
        const tokens: monaco.languages.IToken[] = [];
        for (let index = 0; index < result.tokens.length; index += 2) tokens.push({ startIndex: result.tokens[index]!, scopes: tokenName(result.tokens[index + 1]!) });
        return { tokens, endState: new TextMateState(result.ruleStack) };
      },
    });
    return true;
  }
}
