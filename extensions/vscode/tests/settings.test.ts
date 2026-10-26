import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS, isConnectionToken, parseServerUrl, readOpenRequest, readSettings } from '../src/settings.ts';

describe('settings', () => {
  test('a server address keeps its origin and path prefix, nothing else', () => {
    expect(parseServerUrl(' http://vscode:8000/ ')).toBe('http://vscode:8000');
    expect(parseServerUrl('https://example.com/code/')).toBe('https://example.com/code');
    expect(parseServerUrl('ftp://example.com')).toBeNull();
    expect(parseServerUrl('http://user:pw@example.com')).toBeNull();
    expect(parseServerUrl('http://example.com/?tkn=x')).toBeNull();
    expect(parseServerUrl('not a url')).toBeNull();
  });

  test('stored settings fall back field by field', () => {
    expect(readSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(readSettings({ serverUrl: 'http://vscode:8000/', token: 'abc-123', followTheme: false })).toEqual({ serverUrl: 'http://vscode:8000', token: 'abc-123', followTheme: false });
    expect(readSettings({ serverUrl: 'javascript:alert(1)', token: 'has space', followTheme: 'yes' })).toEqual(DEFAULT_SETTINGS);
  });

  test('a connection token is what VS Code accepts', () => {
    expect(isConnectionToken('e593bff1c28f748f')).toBe(true);
    expect(isConnectionToken('a b')).toBe(false);
    expect(isConnectionToken('')).toBe(false);
    expect(isConnectionToken(42)).toBe(false);
  });

  test('an open request names an absolute folder, maybe a file and a line', () => {
    expect(readOpenRequest({ folder: '/home/node/projects/a', at: 5 })).toEqual({ folder: '/home/node/projects/a', at: 5 });
    expect(readOpenRequest({ folder: '/p', file: '/p/a.ts', line: 12, at: 5 })).toEqual({ folder: '/p', file: '/p/a.ts', line: 12, at: 5 });
    expect(readOpenRequest({ folder: '/p', file: 'relative.ts', line: -1, at: 5 })).toEqual({ folder: '/p', at: 5 });
    expect(readOpenRequest({ folder: 'relative', at: 5 })).toBeNull();
    expect(readOpenRequest({ folder: '/p' })).toBeNull();
  });
});
