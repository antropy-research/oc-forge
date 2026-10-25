import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS, parseServerUrl, readSettings, vscodeFileUrl, vscodeFolderUrl, withoutToken } from '../src/settings.ts';

describe('VS Code Server settings', () => {
  test('a server address is http(s), a host and a port, maybe a path, nothing else', () => {
    expect(parseServerUrl(' http://100.116.120.66:35311/ ')).toBe('http://100.116.120.66:35311');
    expect(parseServerUrl('https://code.example.ts.net/vscode/')).toBe('https://code.example.ts.net/vscode');
    expect(parseServerUrl('http://host:35311/?tkn=x')).toBeNull();
    expect(parseServerUrl('ftp://host')).toBeNull();
    expect(parseServerUrl('http://user:pw@host')).toBeNull();
    expect(parseServerUrl('not a url')).toBeNull();
  });

  test('stored settings are checked, and what is wrong falls back', () => {
    expect(readSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(readSettings({ serverUrl: 'http://h:1', token: 'abc123', theme: 'dark-plus', minimap: false, wordWrap: 'yes' })).toEqual({ ...DEFAULT_SETTINGS, serverUrl: 'http://h:1', token: 'abc123', theme: 'dark-plus', minimap: false });
    expect(readSettings({ token: 'has spaces', theme: '../x' })).toEqual(DEFAULT_SETTINGS);
  });

  test('a folder opens with the token once; VS Code keeps it in a cookie', () => {
    const settings = { ...DEFAULT_SETTINGS, serverUrl: 'http://h:35311', token: 'tok' };
    expect(vscodeFolderUrl(DEFAULT_SETTINGS, '/x')).toBeNull();
    expect(vscodeFolderUrl(settings, '/home/node/projects/a b')).toBe('http://h:35311/?folder=%2Fhome%2Fnode%2Fprojects%2Fa+b&tkn=tok');
    expect(vscodeFolderUrl({ ...settings, token: null }, null)).toBe('http://h:35311/?');
    expect(withoutToken('http://h:35311/?folder=%2Fx&tkn=tok')).toBe('http://h:35311/?folder=%2Fx&tkn=…');
  });

  test('a file opens in its project, at a line, through the payload VS Code web reads', () => {
    const settings = { ...DEFAULT_SETTINGS, serverUrl: 'http://h:35311' };
    const url = new URL(vscodeFileUrl(settings, '/home/node/p/src/main.ts', { folder: '/home/node/p', line: 12 })!);
    expect(url.searchParams.get('folder')).toBe('/home/node/p');
    expect(JSON.parse(url.searchParams.get('payload')!)).toEqual([['openFile', 'vscode-remote://h:35311/home/node/p/src/main.ts:12'], ['gotoLineMode', 'true']]);
    // Outside the open folder, the file's own folder opens.
    expect(new URL(vscodeFileUrl(settings, '/etc/hosts', { folder: '/home/node/p' })!).searchParams.get('folder')).toBe('/etc');
    expect(vscodeFileUrl(settings, 'relative.ts')).toBeNull();
  });
});
