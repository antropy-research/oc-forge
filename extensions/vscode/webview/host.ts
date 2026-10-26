// The webview host page (VS Code's `webview/browser/pre/index.html`, replaced
// in the prepared workbench). VS Code's own page needs a service worker,
// crypto.subtle for its origin check, and same-origin access to the frame it
// writes the content into; inside an OpenChamber extension frame every
// document has an opaque origin, so none of that is there. This page speaks
// the same protocol with the workbench (a MessagePort sent with
// `webview-ready`), reads the content's files through the workbench's
// `load-resource` channel, and shows the content in a srcdoc frame run by
// `agent.ts` over a second MessagePort.
import { prepareContent, resourceRequestOf, type Loaded } from './content.ts';

declare const __OC_WEBVIEW_AGENT__: string;

const params = new URL(location.href).searchParams;
const ID = params.get('id');
const resourceBase = params.get('vscode-resource-base-authority');
const remoteAuthority = params.get('remoteAuthority');

// The same default styles VS Code's own host gives every webview.
const DEFAULT_STYLES = `@layer vscode-default {
html { scrollbar-color: var(--vscode-scrollbarSlider-background) var(--vscode-editor-background); }
body { overscroll-behavior-x: none; background-color: transparent; color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); font-weight: var(--vscode-font-weight); font-size: var(--vscode-font-size); margin: 0; padding: 0 20px; }
img, video { max-width: 100%; max-height: 100%; }
a, a code { color: var(--vscode-textLink-foreground); }
p > a { text-decoration: var(--text-link-decoration); }
a:hover { color: var(--vscode-textLink-activeForeground); }
a:focus, input:focus, select:focus, textarea:focus { outline: 1px solid -webkit-focus-ring-color; outline-offset: -1px; }
code { font-family: var(--monaco-monospace-font); color: var(--vscode-textPreformat-foreground); background-color: var(--vscode-textPreformat-background); padding: 1px 3px; border-radius: 4px; }
pre code { padding: 0; }
blockquote { background: var(--vscode-textBlockQuote-background); border-color: var(--vscode-textBlockQuote-border); }
kbd { background-color: var(--vscode-keybindingLabel-background); color: var(--vscode-keybindingLabel-foreground); border-style: solid; border-width: 1px; border-radius: 3px; border-color: var(--vscode-keybindingLabel-border); border-bottom-color: var(--vscode-keybindingLabel-bottomBorder); box-shadow: inset 0 -1px 0 var(--vscode-widget-shadow); vertical-align: middle; padding: 1px 3px; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-corner { background-color: var(--vscode-editor-background); }
::-webkit-scrollbar-thumb { background-color: var(--vscode-scrollbarSlider-background); }
::-webkit-scrollbar-thumb:hover { background-color: var(--vscode-scrollbarSlider-hoverBackground); }
::-webkit-scrollbar-thumb:active { background-color: var(--vscode-scrollbarSlider-activeBackground); }
::highlight(find-highlight) { background-color: var(--vscode-editor-findMatchHighlightBackground); }
::highlight(current-find-highlight) { background-color: var(--vscode-editor-findMatchBackground); }
}`;

// The workbench side: one MessagePort, sent with `webview-ready`.
const host = new MessageChannel();
const handlers = new Map<string, ((data: any) => void)[]>();
host.port1.onmessage = (event) => {
  for (const handler of handlers.get(event.data?.channel) ?? []) handler(event.data.args);
};
const toHost = (channel: string, data?: unknown, transfer: Transferable[] = []): void => host.port1.postMessage({ channel, data }, transfer);
const on = (channel: string, handler: (data: any) => void): void => {
  handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
};

// Files, as the workbench reads them for a webview.
let nextResource = 0;
const resources = new Map<number, { resolve: (value: Loaded | null) => void; mime?: string; chunks?: Uint8Array[] }>();
const load = (url: string): Promise<Loaded | null> => {
  const request = resourceRequestOf(url, resourceBase, remoteAuthority);
  if (!request) return Promise.resolve(null);
  const id = ++nextResource;
  return new Promise((resolve) => {
    resources.set(id, { resolve });
    toHost('load-resource', { id, ...request });
    setTimeout(() => {
      if (resources.delete(id)) resolve(null);
    }, 30_000);
  });
};
const concat = (chunks: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};
on('did-load-resource', (data) => {
  const pending = resources.get(data.id);
  if (!pending) return;
  if (data.status !== 200 && data.status !== 206) {
    resources.delete(data.id);
    pending.resolve(null);
  } else if (data.stream) {
    resources.delete(data.id);
    void new Response(data.stream as ReadableStream).arrayBuffer().then(
      (buffer) => pending.resolve({ mime: data.mime, bytes: new Uint8Array(buffer) }),
      () => pending.resolve(null),
    );
  } else {
    pending.mime = data.mime;
    pending.chunks = [];
  }
});
on('did-load-resource-chunk', (data) => resources.get(data.id)?.chunks?.push(data.data));
on('did-load-resource-end', (data) => {
  const pending = resources.get(data.id);
  if (!pending) return;
  resources.delete(data.id);
  pending.resolve(data.error ? null : { mime: pending.mime ?? '', bytes: concat(pending.chunks ?? []) });
});
on('did-load-localhost', () => {});

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

// The content frame and its agent.
let styles: unknown = null;
let active: { frame: HTMLIFrameElement; port: MessagePort } | null = null;
let pending: { frame: HTMLIFrameElement; port: MessagePort } | null = null;
let queued: { message: unknown; transfer?: Transferable[] }[] = [];
const toContent = (channel: string, data?: unknown, transfer: Transferable[] = []): void => active?.port.postMessage({ channel, data }, transfer);

const fromContent = (event: MessageEvent): void => {
  const { channel, data } = event.data ?? {};
  if (channel === 'oc-load') {
    void load(data.url).then((loaded) => {
      event.target === active?.port || event.target === pending?.port
        ? (event.target as MessagePort).postMessage({ channel: 'oc-loaded', data: { id: data.id, mime: loaded?.mime ?? '', data: loaded ? toBase64(loaded.bytes) : null } })
        : undefined;
    });
    return;
  }
  if (typeof channel === 'string') toHost(channel, data, channel === 'onmessage' && Array.isArray(data?.transfer) ? data.transfer : []);
};

let updateId = 0;
on('content', async (data) => {
  const current = ++updateId;
  let html: string;
  try {
    html = await prepareContent({
      contents: data.contents,
      options: data.options ?? {},
      state: data.state,
      cspSource: data.cspSource,
      defaultStyles: DEFAULT_STYLES,
      agent: __OC_WEBVIEW_AGENT__,
      styles,
      resourceBase,
      remoteAuthority,
      load,
      isResource: (url) => resourceRequestOf(url, resourceBase, remoteAuthority) !== null,
      DOMParser,
    });
  } catch (error) {
    toHost('fatal-error', { message: String(error) });
    return;
  }
  if (current !== updateId) return;
  pending?.frame.remove();
  const frame = document.createElement('iframe');
  frame.title = data.title ?? '';
  frame.setAttribute('frameborder', '0');
  // Never allow-same-origin: the content has an origin of its own, as in VS Code.
  const sandbox = ['allow-scripts', 'allow-pointer-lock', 'allow-downloads'];
  if (data.options?.allowForms) sandbox.push('allow-forms');
  frame.setAttribute('sandbox', sandbox.join(' '));
  frame.setAttribute('allow', 'cross-origin-isolated; autoplay; clipboard-read; clipboard-write;');
  frame.style.cssText = 'display: block; margin: 0; overflow: hidden; position: absolute; width: 100%; height: 100%; visibility: hidden';
  const channel = new MessageChannel();
  channel.port1.onmessage = fromContent;
  const next = { frame, port: channel.port1 };
  pending = next;
  frame.addEventListener('load', () => {
    if (pending !== next) return;
    frame.contentWindow?.postMessage({ __ocWebviewPort: true }, '*', [channel.port2]);
    active?.frame.remove();
    active = next;
    pending = null;
    frame.setAttribute('id', 'active-frame');
    frame.style.visibility = 'visible';
    if (document.hasFocus()) frame.contentWindow?.focus();
    for (const message of queued.splice(0)) toContent('message', message, message.transfer ?? []);
  }, { once: true });
  frame.srcdoc = html;
  document.body.append(frame);
});

on('styles', (data) => {
  styles = data;
  toContent('styles', data);
});
on('message', (data) => {
  if (pending || !active) queued.push(data);
  else toContent('message', data, data.transfer ?? []);
});
on('focus', () => {
  if (active?.frame.contentWindow) active.frame.contentWindow.focus();
  else window.focus();
});
on('set-title', (title) => {
  if (active) active.frame.title = title;
});
for (const channel of ['execCommand', 'find', 'find-stop', 'set-context-menu-visible']) on(channel, (data) => toContent(channel, data));
on('initial-scroll-position', () => {});
on('set-confirm-before-close', () => {});

// Keys on the page itself, before any content is there, go to VS Code as VS Code's host sends them.
for (const type of ['keydown', 'keyup'] as const) window.addEventListener(type, (event) => {
  toHost(`did-${type}`, { key: event.key, keyCode: event.keyCode, code: event.code, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, repeat: event.repeat, isTrusted: event.isTrusted });
});

// Focus, as VS Code's host tracks it: the page or the content frame inside it.
let focused = document.hasFocus();
setInterval(() => {
  const now = document.hasFocus();
  if (now === focused) return;
  focused = now;
  toHost(now ? 'did-focus' : 'did-blur');
}, 250);

// Ready: the workbench takes our port. The workbench's origin cannot be named from an opaque origin.
window.parent.postMessage({ target: ID, channel: 'webview-ready', data: {} }, '*', [host.port2]);
