import { describe, expect, test } from 'bun:test';
import { DOMParser } from 'linkedom';
import { absoluteImports, closeSafe, cspNonce, prepareContent, relaxCsp, resourceRequestOf, type Loaded } from '../webview/content.ts';
import { createKeyEventToken, KEY_CHANNELS, keyEventData, readyMessage } from '../webview/protocol.ts';

const BASE = 'vscode-resource.vscode-cdn.net';
const resource = (path: string) => `https://vscode-remote+vscode-003a8000.${BASE}${path}`;

describe('webview resource URLs', () => {
  test('are read the way VS Code\'s service worker reads them', () => {
    expect(resourceRequestOf(`${resource('/opt/x/media/index.js')}?v=1`, BASE, 'vscode:8000')).toEqual({ scheme: 'vscode-remote', authority: 'vscode-003a8000', path: '/opt/x/media/index.js', query: 'v=1' });
    expect(resourceRequestOf(`https://file+.${BASE}/home/a.png`, BASE, null)).toEqual({ scheme: 'file', authority: '', path: '/home/a.png', query: '' });
    expect(resourceRequestOf('http://vscode:8000/stable-x/vscode-remote-resource?path=%2Fa', BASE, 'vscode:8000')).toEqual({ scheme: 'http', authority: 'vscode:8000', path: '/stable-x/vscode-remote-resource', query: 'path=%2Fa' });
    expect(resourceRequestOf('https://example.com/a.png', BASE, 'vscode:8000')).toBeNull();
    expect(resourceRequestOf(`http://evil.${BASE}/a`, BASE, null)).toBeNull();
  });
});

describe('the webview CSP', () => {
  test('keeps its nonce, takes data: and blob: for files, and the agent where scripts are none', () => {
    const policy = "default-src 'none'; img-src https: data:; script-src 'nonce-abc'; style-src 'unsafe-inline' https:";
    expect(cspNonce(policy, 'script')).toBe('abc');
    expect(cspNonce(policy, 'style')).toBeNull();
    const relaxed = relaxCsp(policy, 'agent', true);
    expect(relaxed).toContain("script-src 'nonce-abc' blob:");
    expect(relaxed).toContain('img-src https: data: blob:');
    expect(relaxed).toContain("default-src 'none'");
    // Directives that fell back to default-src 'none' stay closed, except scripts, which only the agent may run.
    expect(relaxCsp("default-src 'none'", 'agent')).toBe("default-src 'none'; script-src 'nonce-agent'; style-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'");
    expect(relaxCsp("script-src 'self' https:", 'agent')).toBe("script-src 'self' https: 'unsafe-inline'");
    expect(relaxCsp("script-src 'sha256-xyz='", 'agent')).toBe("script-src 'sha256-xyz=' 'nonce-agent'");
  });

  test('inline text never closes its own element', () => {
    expect(closeSafe('a="</script>";', 'script')).toBe('a="<\\/script>";');
    expect(closeSafe('/* </STYLE> */', 'style')).toBe('/* <\\/STYLE> */');
  });
});

describe('module imports', () => {
  test('become absolute against the module\'s own URL', () => {
    const { text, urls } = absoluteImports('import{a as b}from"./chunk-A.js";import"../side.js";const m=import("./lazy.js");', resource('/ext/out/index.js'));
    expect(urls).toEqual([resource('/ext/out/chunk-A.js'), resource('/ext/side.js'), resource('/ext/out/lazy.js')]);
    expect(text).toBe(`import{a as b}from"${resource('/ext/out/chunk-A.js')}";import"${resource('/ext/side.js')}";const m=import("${resource('/ext/out/lazy.js')}");`);
  });
});

describe('a webview made self-contained', () => {
  const files: Record<string, string> = {
    [resource('/ext/media/index.js')]: 'console.log("</script>");',
    [resource('/ext/media/app.mjs')]: 'import{x}from"./chunk.js";x();',
    [resource('/ext/media/chunk.js')]: 'export const x=()=>1;',
    [resource('/ext/media/style.css')]: '.a{background:url(./icon.svg)}',
    [resource('/ext/media/icon.svg')]: '<svg/>',
    [resource('/home/p/pic.png')]: 'PNG',
  };
  const load = async (url: string): Promise<Loaded | null> => (url in files ? { mime: url.endsWith('.png') ? 'image/png' : url.endsWith('.svg') ? 'image/svg+xml' : 'text/plain', bytes: new TextEncoder().encode(files[url]) } : null);
  const isResource = (url: string) => resourceRequestOf(url, BASE, 'vscode:8000') !== null;
  const contents = `<!DOCTYPE html><html><head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; script-src 'nonce-n1'; style-src 'unsafe-inline' https:">
    <meta http-equiv="refresh" content="1">
    <base href="${resource('/home/p/README.md')}">
    <link rel="stylesheet" href="${resource('/ext/media/style.css')}">
    <script src="${resource('/ext/media/index.js')}" nonce="n1"></script>
    <script type="module" src="${resource('/ext/media/app.mjs')}" nonce="n1"></script>
  </head><body><h1>Title</h1><img src="pic.png"><a href="other.md">other</a></body></html>`;

  test('scripts, styles and images go inline; the agent and its settings come first', async () => {
    const html = await prepareContent({ contents, options: { allowScripts: true }, cspSource: `https://*.${BASE}`, defaultStyles: '.default{}', agent: 'window.agent=1', styles: { activeTheme: 'vscode-dark' }, resourceBase: BASE, remoteAuthority: 'vscode:8000', load, isResource, DOMParser: DOMParser as never });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const head = [...doc.head.children].map((element) => element.id || element.tagName.toLowerCase());
    // CSP first, then the agent's settings, the agent and VS Code's default styles, then the webview's own head.
    expect(head.slice(0, 4)).toEqual(['meta', '_ocWebviewConfig', '_ocWebviewAgent', '_defaultStyles']);
    expect(doc.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    const scripts = [...doc.querySelectorAll('script')].filter((script) => !script.id);
    expect(scripts.map((script) => [script.getAttribute('src'), script.getAttribute('nonce'), script.textContent])).toEqual([
      [null, 'n1', 'console.log("<\\/script>");'],
      [null, 'n1', `import{x}from"${resource('/ext/media/chunk.js')}";x();`],
    ]);
    const config = JSON.parse(doc.getElementById('_ocWebviewConfig')!.textContent!);
    expect(config.modules).toEqual({ [resource('/ext/media/chunk.js')]: 'export const x=()=>1;' });
    expect(config.styles).toEqual({ activeTheme: 'vscode-dark' });
    expect(doc.getElementById('_ocWebviewAgent')!.getAttribute('nonce')).toBe('n1');
    expect(doc.querySelector('style:not(#_defaultStyles)')!.textContent).toBe('.a{background:url(data:image/svg+xml;base64,PHN2Zy8+)}');
    expect(doc.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,UE5H');
    expect(doc.querySelector('a')!.getAttribute('title')).toBe('other.md');
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')).toContain("script-src 'nonce-n1' blob:");
  });

  test('a webview that may not run scripts loses them; only the agent runs, under a nonce of its own', async () => {
    const html = await prepareContent({ contents: contents.replace('<h1>', '<h1 onclick="alert(1)">'), options: { allowScripts: false }, defaultStyles: '', agent: 'window.agent=1', styles: null, resourceBase: BASE, remoteAuthority: null, load, isResource, DOMParser: DOMParser as never });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect([...doc.querySelectorAll('script')].map((script) => script.id)).toEqual(['_ocWebviewConfig', '_ocWebviewAgent']);
    expect(doc.querySelector('h1')!.getAttribute('onclick')).toBeNull();
    const nonce = doc.getElementById('_ocWebviewAgent')!.getAttribute('nonce');
    expect(nonce).toBe('n1');
  });
});

describe('the handshake and key events, as VS Code 1.143 checks them', () => {
  test('webview-ready names the mount id from the page\'s URL and a token for the page\'s life', () => {
    const token = createKeyEventToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(createKeyEventToken()).not.toBe(token);
    expect(createKeyEventToken((bytes) => bytes.fill(171))).toBe('ab'.repeat(16));
    const params = new URLSearchParams('id=w1&mountId=6f1c2d3e-uuid&platform=browser');
    expect(readyMessage('w1', params, token)).toEqual({ target: 'w1', channel: 'webview-ready', data: { keyEventToken: token, mountId: '6f1c2d3e-uuid' } });
    // VS Code 1.140 puts no mount id in the URL and ignores the data.
    expect(readyMessage('w1', new URLSearchParams('id=w1'), token).data.mountId).toBeNull();
  });

  test('key events carry the token, only the fields VS Code reads, whatever the content added', () => {
    expect([...KEY_CHANNELS]).toEqual(['did-keydown', 'did-keyup']);
    const forged = { key: 'p', keyCode: 80, code: 'KeyP', shiftKey: true, altKey: false, ctrlKey: true, metaKey: false, repeat: false, isTrusted: true, keyEventToken: 'guessed', extra: 1 };
    expect(keyEventData(forged, 'abc')).toEqual({ key: 'p', keyCode: 80, code: 'KeyP', shiftKey: true, altKey: false, ctrlKey: true, metaKey: false, repeat: false, isTrusted: true, keyEventToken: 'abc' });
  });
});
