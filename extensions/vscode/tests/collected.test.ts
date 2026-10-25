// The VS Code data in editor/vscode, as collected from VS Code 1.140.0, and the
// manifest: every file the editor claims has a VS Code language with a
// grammar, and a line of TypeScript comes out in Dark Modern's very colors.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INITIAL, Registry, type IRawGrammar } from 'vscode-textmate';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';
import { FILE_EDITORS } from '../src/fileTypes.ts';
import { languageFor, type VscodeIndex, type VscodeThemeFile } from '../src/vscodeData.ts';
import { themeRules, tokenName } from '../src/monacoConfig.ts';

const root = join(import.meta.dir, '..');
const data = join(root, 'editor', 'vscode');
const index = JSON.parse(readFileSync(join(data, 'index.json'), 'utf8')) as VscodeIndex;
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { openchamber: { contributes: { fileEditors: { id: string; title: string; match: string[]; entry: string }[] } } };

describe('the collected VS Code data', () => {
  test('comes from the VS Code that vendors.json pins', () => {
    const pins = JSON.parse(readFileSync(join(root, '..', '..', 'vendors.json'), 'utf8')) as { vscode: { release: string; commit: string } };
    expect(index.vscode).toEqual({ version: pins.vscode.release, commit: pins.vscode.commit });
    expect(index.themes.map((theme) => theme.id)).toEqual(['dark-modern', 'light-modern', 'dark-plus', 'light-plus']);
    for (const grammar of index.grammars) expect(existsSync(join(data, 'grammars', grammar.file))).toBe(true);
    for (const language of index.languages.filter((item) => item.configuration)) expect(existsSync(join(data, 'languages', `${language.id}.json`))).toBe(true);
  });

  test('the manifest claims what src/fileTypes.ts lists, and VS Code colors each of those files', () => {
    expect(manifest.openchamber.contributes.fileEditors).toEqual(FILE_EDITORS.map((entry) => ({ ...entry, entry: 'editor/index.html' })));
    for (const entry of FILE_EDITORS) {
      expect(entry.match.length).toBeLessThanOrEqual(16);
      for (const pattern of entry.match) {
        const sample = pattern.replace('*', 'sample');
        const language = languageFor(index, sample);
        expect({ pattern, scopeName: language?.scopeName ?? null }).toEqual({ pattern, scopeName: expect.any(String) });
      }
    }
    // OpenChamber previews these itself; the editor leaves them alone.
    const claimed = FILE_EDITORS.flatMap((entry) => entry.match);
    for (const previewed of ['*.md', '*.json', '*.html', '*.svg', '*.csv', '*.drawio', '*.mmd']) expect(claimed).not.toContain(previewed);
  });
});

describe('coloring', () => {
  test("a line of TypeScript gets Dark Modern's colors, as in VS Code", async () => {
    await loadWASM(readFileSync(join(root, 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm')));
    const registry = new Registry({
      onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
      loadGrammar: async (scopeName) => {
        const grammar = index.grammars.find((item) => item.scopeName === scopeName);
        return grammar ? (JSON.parse(readFileSync(join(data, 'grammars', grammar.file), 'utf8')) as IRawGrammar) : null;
      },
    });
    const theme = JSON.parse(readFileSync(join(data, 'themes', 'dark-modern.json'), 'utf8')) as VscodeThemeFile;
    registry.setTheme({ name: 'Dark Modern', settings: [{ settings: { foreground: theme.colors?.['editor.foreground'], background: theme.colors?.['editor.background'] } }, ...(theme.tokenColors ?? []).map((rule) => ({ scope: rule.scope, settings: rule.settings }))] });
    const scopeName = languageFor(index, 'main.ts')!.scopeName!;
    const grammar = (await registry.loadGrammar(scopeName))!;
    const line = 'const answer = 42; // the answer';
    const { tokens } = grammar.tokenizeLine2(line, INITIAL);
    // What Monaco draws: each token's name, looked up in the theme rules made from the color map.
    const rules = new Map(themeRules(registry.getColorMap()).map((rule) => [rule.token, rule]));
    const colorOf = (text: string) => {
      const at = line.indexOf(text);
      let metadata = 0;
      for (let i = 0; i < tokens.length; i += 2) if (tokens[i]! <= at) metadata = tokens[i + 1]!;
      return rules.get(tokenName(metadata));
    };
    expect(colorOf('const')?.foreground).toBe('569cd6');
    expect(colorOf('answer')?.foreground).toBe('4fc1ff');
    expect(colorOf('42')?.foreground).toBe('b5cea8');
    expect(colorOf('// the')?.foreground).toBe('6a9955');
  });
});
