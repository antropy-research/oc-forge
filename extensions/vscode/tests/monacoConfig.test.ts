import { describe, expect, test } from 'bun:test';
import { editorColors, themeRules, tokenName, toMonacoConfiguration } from '../src/monacoConfig.ts';

describe("VS Code's language configuration for Monaco", () => {
  test('comments, brackets, pairs and patterns, with strings turned into RegExps', () => {
    const config = toMonacoConfiguration({
      comments: { lineComment: { comment: '//' }, blockComment: ['/*', '*/'] },
      brackets: [['{', '}'], ['(', ')'], 'bad'],
      autoClosingPairs: [['"', '"'], { open: "'", close: "'", notIn: ['string', 'comment'] }],
      surroundingPairs: [['(', ')']],
      wordPattern: { pattern: '(-?\\d*\\.\\d\\w*)|([^\\s]+)', flags: 'g' },
      indentationRules: { increaseIndentPattern: '^.*\\{[^}"\']*$', decreaseIndentPattern: '^\\s*\\}' },
      onEnterRules: [{ beforeText: '^\\s*/\\*\\*(?!/)([^*]|\\*(?!/))*$', afterText: { pattern: '^\\s*\\*/$' }, action: { indent: 'indentOutdent', appendText: ' * ' } }],
      folding: { markers: { start: '^\\s*//\\s*#?region\\b', end: '^\\s*//\\s*#?endregion\\b' } },
    });
    expect(config.comments).toEqual({ lineComment: '//', blockComment: ['/*', '*/'] });
    expect(config.brackets).toEqual([['{', '}'], ['(', ')']]);
    expect(config.autoClosingPairs).toEqual([{ open: '"', close: '"' }, { open: "'", close: "'", notIn: ['string', 'comment'] }]);
    expect(config.wordPattern).toBeInstanceOf(RegExp);
    expect(config.wordPattern?.flags).toBe('g');
    expect(config.indentationRules?.increaseIndentPattern.test('if (x) {')).toBe(true);
    expect(config.onEnterRules?.[0]?.action).toEqual({ indentAction: 2, appendText: ' * ' });
    expect(config.folding?.markers?.start.test('// #region tools')).toBe(true);
  });

  test("a pattern JavaScript cannot read is left out, not thrown", () => {
    expect(toMonacoConfiguration({ wordPattern: '(?<!a(' }).wordPattern).toBeUndefined();
    expect(toMonacoConfiguration(null)).toEqual({});
  });
});

describe('colors', () => {
  test('a token is named by its foreground index and font style', () => {
    const metadata = (foreground: number, fontStyle: number) => (foreground << 15) | (fontStyle << 11);
    expect(tokenName(metadata(7, 0))).toBe('tm7');
    expect(tokenName(metadata(12, 1 | 2))).toBe('tm12s3');
  });

  test('every color of the map has a rule for each font style', () => {
    const rules = themeRules(['', '#D4D4D4', '#569cd6', 'bogus']);
    expect(rules).toHaveLength(2 * 16);
    expect(rules[0]).toEqual({ token: 'tm1', foreground: 'd4d4d4' });
    expect(rules.find((rule) => rule.token === 'tm2s5')).toEqual({ token: 'tm2s5', foreground: '569cd6', fontStyle: 'italic underline' });
    expect(editorColors({ 'editor.background': '#1f1f1f', 'editor.foreground': 'red', 'focusBorder': '#0078d4cc' })).toEqual({ 'editor.background': '#1f1f1f', 'focusBorder': '#0078d4cc' });
  });
});
