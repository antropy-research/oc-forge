import { describe, expect, test } from 'bun:test';
import { collectLanguages, globMatches, grammarFile, languageFor, parseJsonc, resolveTheme, type ExtensionManifest, type VscodeThemeFile } from '../src/vscodeData.ts';

describe('languages from built-in extensions', () => {
  const typescript: ExtensionManifest = {
    name: 'typescript-basics',
    contributes: {
      languages: [{ id: 'typescript', aliases: ['TypeScript', 'ts'], extensions: ['.ts', '.CTS', '.mts'], configuration: './language-configuration.json' }],
      grammars: [
        { language: 'typescript', scopeName: 'source.ts', path: './syntaxes/TypeScript.tmLanguage.json' },
        { scopeName: 'documentation.injection.ts', path: './syntaxes/jsdoc.ts.injection.tmLanguage.json', injectTo: ['source.ts'] },
      ],
    },
  };
  const docker: ExtensionManifest = { name: 'docker', contributes: { grammars: [{ language: 'dockerfile', scopeName: 'source.dockerfile', path: './syntaxes/docker.tmLanguage.json' }], languages: [{ id: 'dockerfile', extensions: ['.dockerfile', '.containerfile'], filenames: ['Dockerfile', 'Containerfile'], filenamePatterns: ['Dockerfile.*'] }] } };
  const more: ExtensionManifest = { name: 'other', contributes: { languages: [{ id: 'typescript', extensions: ['.ts'], filenames: ['tsfile'] }] } };
  const { languages, grammars, grammarPaths, configurationPaths } = collectLanguages([typescript, docker, more]);

  test('merged per language, with its grammar, even when the grammar comes first', () => {
    expect(languages.map((language) => language.id)).toEqual(['dockerfile', 'typescript']);
    expect(languages.find((language) => language.id === 'typescript')).toEqual({ id: 'typescript', aliases: ['TypeScript', 'ts'], extensions: ['.ts', '.cts', '.mts'], filenames: ['tsfile'], filenamePatterns: [], scopeName: 'source.ts', configuration: true });
    expect(languages.find((language) => language.id === 'dockerfile')?.scopeName).toBe('source.dockerfile');
    expect(grammars.find((grammar) => grammar.scopeName === 'documentation.injection.ts')).toEqual({ scopeName: 'documentation.injection.ts', file: 'documentation.injection.ts.json', injectTo: ['source.ts'], embeddedLanguages: {} });
    expect(grammarPaths.get('source.ts')?.path).toBe('./syntaxes/TypeScript.tmLanguage.json');
    expect(configurationPaths.get('typescript')?.path).toBe('./language-configuration.json');
    expect(grammarFile('text.html.php$1')).toBe('text.html.php_1.json');
  });

  test('a file finds its language as VS Code finds it', () => {
    const index = { languages };
    expect(languageFor(index, 'Dockerfile')?.id).toBe('dockerfile');
    expect(languageFor(index, 'Dockerfile.prod')?.id).toBe('dockerfile');
    expect(languageFor(index, 'main.TS')?.id).toBe('typescript');
    expect(languageFor(index, 'ts')).toBeNull();
    expect(languageFor(index, '.ts')?.id).toBe('typescript');
    expect(languageFor(index, 'notes.txt')).toBeNull();
    expect(globMatches('*.config.js', 'vite.config.js')).toBe(true);
    expect(globMatches('**/.github/*.yml', 'x.yml')).toBe(false);
  });
});

describe('VS Code files', () => {
  test('JSON with comments and trailing commas, strings left alone', () => {
    const text = `{
      // a comment "with quotes"
      "lineComment": "//", /* block */
      "pattern": "[^,\\\\]]+,]",
      "list": [1, 2, ],
      "nested": { "a": "b", },
    }`;
    expect(parseJsonc(text)).toEqual({ lineComment: '//', pattern: '[^,\\]]+,]', list: [1, 2], nested: { a: 'b' } });
  });

  test('a theme takes its included parents first, then its own colors', () => {
    const files: Record<string, VscodeThemeFile> = {
      './dark_vs.json': { colors: { 'editor.background': '#1e1e1e', 'editor.foreground': '#d4d4d4' }, tokenColors: [{ scope: 'comment', settings: { foreground: '#6a9955' } }] },
      './dark_plus.json': { include: './dark_vs.json', tokenColors: [{ scope: 'entity.name.function', settings: { foreground: '#dcdcaa' } }] },
    };
    const theme = resolveTheme({ name: 'Dark Modern', include: './dark_plus.json', colors: { 'editor.background': '#1f1f1f' } }, (path) => files[path]!);
    expect(theme.colors).toEqual({ 'editor.background': '#1f1f1f', 'editor.foreground': '#d4d4d4' });
    expect(theme.tokenColors?.map((rule) => rule.scope)).toEqual(['comment', 'entity.name.function']);
  });
});
