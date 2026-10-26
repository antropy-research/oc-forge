import { describe, expect, test } from 'bun:test';
import { commitOfBase, isExternalAllowed, readServerPage, remoteUri, serverPathOf, workbenchConfiguration } from '../src/workbench.ts';

const server = {
  remoteAuthority: 'vscode:8000',
  serverBasePath: '/',
  enableWorkspaceTrust: true,
  callbackRoute: '/stable-abc/callback',
  productConfiguration: { extensionsGallery: { serviceUrl: 'https://marketplace.visualstudio.com/_apis/public/gallery' }, tasConfig: { endpoint: 'x' }, aiConfig: {} },
};

describe('the workbench configuration', () => {
  test("opens OpenChamber's folder on the server, with the token, without trust prompts or telemetry", () => {
    const config = workbenchConfiguration(server, { folder: '/home/node/projects/a', token: 'tok', mode: 'dark', followTheme: true });
    expect(config.folderUri).toEqual({ scheme: 'vscode-remote', authority: 'vscode:8000', path: '/home/node/projects/a' });
    expect(config.connectionToken).toBe('tok');
    expect(config.enableWorkspaceTrust).toBe(false);
    expect(config.initialColorTheme).toEqual({ themeType: 'dark' });
    const product = config.productConfiguration as Record<string, unknown>;
    expect(product.tasConfig).toBeUndefined();
    expect(product.aiConfig).toBeUndefined();
    expect(product.enableTelemetry).toBe(false);
    expect(product.extensionsGallery).toEqual(server.productConfiguration.extensionsGallery);
    const defaults = config.configurationDefaults as Record<string, unknown>;
    expect(defaults['workbench.colorTheme']).toBe('Dark 2026');
    expect(defaults['chat.disableAIFeatures']).toBe(true);
    expect(defaults['workbench.secondarySideBar.defaultVisibility']).toBe('hidden');
  });

  test('without a folder VS Code opens empty; without following the look the theme is the user\'s', () => {
    const config = workbenchConfiguration(server, { folder: null, token: null, mode: 'light', followTheme: false });
    expect(config.folderUri).toBeUndefined();
    expect(config.connectionToken).toBeUndefined();
    expect((config.configurationDefaults as Record<string, unknown>)['workbench.colorTheme']).toBeUndefined();
    expect(remoteUri('h:1', '/x')).toEqual({ scheme: 'vscode-remote', authority: 'h:1', path: '/x' });
  });
});

describe('where requests go', () => {
  test("the server's URLs are told apart by the remote authority", () => {
    expect(serverPathOf('http://vscode:8000/stable-abc/vscode-remote-resource?path=%2Fx&tkn=t', 'vscode:8000')).toBe('/stable-abc/vscode-remote-resource?path=%2Fx&tkn=t');
    expect(serverPathOf('https://vscode:8000/a', 'vscode:8000')).toBe('/a');
    expect(serverPathOf('http://other:8000/a', 'vscode:8000')).toBeNull();
    expect(serverPathOf('blob:null/abc', 'vscode:8000')).toBeNull();
    expect(serverPathOf('not a url', 'vscode:8000')).toBeNull();
  });

  test('only the gallery and VS Code CDNs are reachable outside, over https', () => {
    expect(isExternalAllowed('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery')).toBe(true);
    expect(isExternalAllowed('https://ms-python.gallerycdn.vsassets.io/x.png')).toBe(true);
    expect(isExternalAllowed('https://main.vscode-cdn.net/extensions/marketplace.json')).toBe(true);
    expect(isExternalAllowed('https://open-vsx.org/api/x')).toBe(true);
    expect(isExternalAllowed('http://marketplace.visualstudio.com/x')).toBe(false);
    expect(isExternalAllowed('https://evil-vsassets.io.example.com/x')).toBe(false);
    expect(isExternalAllowed('https://marketplace.visualstudio.com.evil.com/x')).toBe(false);
    expect(isExternalAllowed('https://user:pw@marketplace.visualstudio.com/x')).toBe(false);
    expect(isExternalAllowed('https://169.254.169.254/latest')).toBe(false);
  });
});

describe('the VS Code Server page', () => {
  test('its configuration and commit are read from the page', () => {
    const settings = JSON.stringify(server).replaceAll('"', '&quot;');
    const html = `<meta id="vscode-workbench-web-configuration" data-settings="${settings}">\n<meta id="vscode-workbench-web-base-url" data-settings="/stable-07f806f999227108933c2e30515b26eecc1fda74/static">`;
    const page = readServerPage(html);
    expect(page?.config.remoteAuthority).toBe('vscode:8000');
    expect(page?.base).toBe('/stable-07f806f999227108933c2e30515b26eecc1fda74/static');
    expect(commitOfBase(page!.base)).toBe('07f806f999227108933c2e30515b26eecc1fda74');
    expect(readServerPage('<html>not vscode</html>')).toBeNull();
    expect(commitOfBase('/static')).toBeNull();
  });
});
