// Runs first in a webview's content document. The content is a srcdoc frame
// of the webview host page; both have opaque origins, so the host cannot reach
// into it as VS Code's own host does. Instead this agent does from inside what
// VS Code's host does from outside (theme variables, keyboard and link events,
// find, size), gives the content `acquireVsCodeApi`, and talks to the host over
// a MessagePort the host hands it. Files the content asks for later (images,
// scripts, styles, fetch) come through the host as well.

interface Config {
  /** `vscode-resource.vscode-cdn.net`: webview resource URLs are on its subdomains. */
  resourceBase: string | null;
  remoteAuthority: string | null;
  allowScripts: boolean;
  allowMultipleAPIAcquire: boolean;
  state: string | null;
  /** Modules the content's module scripts import, by absolute URL. */
  modules?: Record<string, string>;
  styles: { styles?: Record<string, string>; activeTheme?: string; themeLabel?: string; themeId?: string; reduceMotion?: boolean; screenReader?: boolean } | null;
}

(() => {
  const config: Config = JSON.parse(document.getElementById('_ocWebviewConfig')?.textContent || '{}');
  // Browsers hide a nonce from getAttribute once its script runs; the property keeps it.
  const nonce = (document.getElementById('_ocWebviewAgent') as HTMLScriptElement | null)?.nonce ?? '';

  // Module scripts: their imports are here as text; an import map points their URLs at blob: copies.
  const moduleUrls = Object.entries(config.modules ?? {});
  if (moduleUrls.length > 0) {
    const imports: Record<string, string> = {};
    for (const [url, text] of moduleUrls) imports[url] = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    const map = document.createElement('script');
    map.type = 'importmap';
    map.setAttribute('nonce', nonce);
    map.textContent = JSON.stringify({ imports });
    document.getElementById('_ocWebviewAgent')?.after(map);
  }
  let port: MessagePort | null = null;
  const outbox: { channel: string; data: unknown; transfer: Transferable[] }[] = [];
  const send = (channel: string, data?: unknown, transfer: Transferable[] = []): void => {
    if (port) port.postMessage({ channel, data }, transfer);
    else outbox.push({ channel, data, transfer });
  };

  // Files: the host reads webview resources for the content.
  let nextLoad = 0;
  const loads = new Map<number, (answer: { mime: string; data: string } | null) => void>();
  const isResource = (url: string): boolean => {
    try {
      const parsed = new URL(url, document.baseURI);
      return (Boolean(config.resourceBase) && parsed.protocol === 'https:' && parsed.hostname.endsWith(`.${config.resourceBase}`))
        || (Boolean(config.remoteAuthority) && parsed.host === config.remoteAuthority && /^https?:$/.test(parsed.protocol));
    } catch {
      return false;
    }
  };
  const load = (url: string): Promise<{ mime: string; data: string } | null> => new Promise((resolve) => {
    const id = ++nextLoad;
    loads.set(id, resolve);
    send('oc-load', { id, url });
  });
  const dataUrlOf = (answer: { mime: string; data: string }): string => `data:${answer.mime || 'application/octet-stream'};base64,${answer.data}`;
  const textOf = (answer: { data: string }): string => new TextDecoder().decode(Uint8Array.from(atob(answer.data), (char) => char.charCodeAt(0)));

  const applyStyles = (): void => {
    const data = config.styles;
    if (!data) return;
    const style = document.documentElement.style;
    for (let index = style.length - 1; index >= 0; index--) {
      const property = style[index];
      if (property?.startsWith('--vscode-')) style.removeProperty(property);
    }
    for (const [name, value] of Object.entries(data.styles ?? {})) style.setProperty(`--${name}`, value);
    const body = document.body;
    if (!body) return;
    body.classList.remove('vscode-light', 'vscode-dark', 'vscode-high-contrast', 'vscode-high-contrast-light', 'vscode-reduce-motion', 'vscode-using-screen-reader');
    if (data.activeTheme) {
      body.classList.add(data.activeTheme);
      if (data.activeTheme === 'vscode-high-contrast-light') body.classList.add('vscode-high-contrast');
    }
    if (data.reduceMotion) body.classList.add('vscode-reduce-motion');
    if (data.screenReader) body.classList.add('vscode-using-screen-reader');
    body.dataset.vscodeThemeKind = data.activeTheme ?? '';
    body.dataset.vscodeThemeName = data.themeLabel ?? '';
    body.dataset.vscodeThemeId = data.themeId ?? '';
  };
  applyStyles();
  document.addEventListener('DOMContentLoaded', applyStyles);

  // From the host: the extension's messages, styles, focus, find.
  let lastFind: string | undefined;
  const onHost = (event: MessageEvent): void => {
    const { channel, data } = event.data ?? {};
    switch (channel) {
      case 'message':
        window.dispatchEvent(new MessageEvent('message', { data: data.message }));
        break;
      case 'styles':
        config.styles = data;
        applyStyles();
        break;
      case 'focus':
        window.focus();
        break;
      case 'execCommand':
        document.execCommand(data);
        break;
      case 'set-context-menu-visible':
        document.body?.classList.toggle('vscode-context-menu-visible', Boolean(data?.visible));
        break;
      case 'find': {
        if (!data.previous && lastFind !== data.value) window.getSelection()?.collapse(window.getSelection()?.anchorNode ?? null);
        lastFind = data.value;
        const found = (window as unknown as { find: (...args: unknown[]) => boolean }).find(data.value, false, data.previous, true, false, false, false);
        send('did-find', found);
        break;
      }
      case 'find-stop': {
        lastFind = undefined;
        if (!data?.clearSelection) {
          const selection = window.getSelection();
          for (let index = 0; selection && index < selection.rangeCount; index++) selection.removeRange(selection.getRangeAt(index));
        }
        break;
      }
      case 'oc-loaded': {
        const resolve = loads.get(data.id);
        loads.delete(data.id);
        resolve?.(data.data === null ? null : { mime: data.mime, data: data.data });
        break;
      }
    }
  };
  window.addEventListener('message', (event) => {
    if (!port && event.data && event.data.__ocWebviewPort && event.ports[0]) {
      event.stopImmediatePropagation();
      port = event.ports[0];
      port.onmessage = onHost;
      for (const item of outbox.splice(0)) port.postMessage({ channel: item.channel, data: item.data }, item.transfer);
    }
  }, true);

  // The VS Code API for the extension's own scripts.
  if (config.allowScripts) {
    let acquired = false;
    let state: unknown = config.state ? JSON.parse(decodeURIComponent(config.state)) : undefined;
    (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => {
      if (acquired && !config.allowMultipleAPIAcquire) throw new Error('An instance of the VS Code API has already been acquired');
      acquired = true;
      return Object.freeze({
        postMessage: (message: unknown, transfer?: Transferable[]) => send('onmessage', { message, transfer }, transfer ?? []),
        setState: (next: unknown) => {
          state = next;
          send('do-update-state', JSON.stringify(next));
          return next;
        },
        getState: () => state,
      });
    };
  }

  // Keys, links, menus, scrolling, size: what VS Code's host listens for.
  const meta = (event: KeyboardEvent) => event.ctrlKey || event.metaKey;
  const keyData = (event: KeyboardEvent) => ({ key: event.key, keyCode: event.keyCode, code: event.code, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, repeat: event.repeat, isTrusted: event.isTrusted });
  window.addEventListener('keydown', (event) => {
    const code = event.keyCode;
    const copyPaste = (meta(event) && [67, 86, 88].includes(code)) || (event.shiftKey && code === 45);
    if ((meta(event) && [90, 89, 80, 70, 83].includes(code)) || (!copyPaste && ((meta(event) && [87, 78].includes(code)) || code === 112 || code === 116))) event.preventDefault();
    send('did-keydown', keyData(event));
  });
  window.addEventListener('keyup', (event) => send('did-keyup', keyData(event)));
  window.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    const base = document.querySelector('base');
    for (const node of event.composedPath() as HTMLAnchorElement[]) {
      if (node.tagName?.toLowerCase() !== 'a' || !node.href) continue;
      if (node.getAttribute('href') === '#') window.scrollTo(0, 0);
      else if (node.hash && (node.getAttribute('href') === node.hash || (base && node.href === base.href + node.hash))) {
        const fragment = node.hash.slice(1);
        const target = document.getElementById(fragment) ?? document.getElementById(decodeURIComponent(fragment));
        if (target) target.scrollIntoView();
        else if (decodeURIComponent(fragment).toLowerCase() === 'top') window.scrollTo(0, 0);
      } else {
        send('did-click-link', { uri: (node.href as unknown as { baseVal?: string }).baseVal || node.href });
      }
      event.preventDefault();
      return;
    }
  });
  window.addEventListener('auxclick', (event) => {
    if (event.button === 1 && (event.composedPath() as Element[]).some((node) => node.tagName?.toLowerCase() === 'a')) event.preventDefault();
  });
  window.addEventListener('contextmenu', (event) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    let context: Record<string, unknown> = {};
    let element = event.target as HTMLElement | null;
    while (element) {
      element = element.closest('[data-vscode-context]');
      if (!element) break;
      try {
        context = { ...JSON.parse(element.dataset.vscodeContext ?? '{}'), ...context };
      } catch {
        // Not JSON: ignored, as VS Code does.
      }
      element = element.parentElement;
    }
    send('did-context-menu', { clientX: event.clientX, clientY: event.clientY, context });
  });
  let scrolling = false;
  window.addEventListener('scroll', () => {
    if (scrolling || !document.body) return;
    const progress = window.scrollY / document.body.clientHeight;
    if (Number.isNaN(progress)) return;
    scrolling = true;
    requestAnimationFrame(() => {
      send('did-scroll', { scrollYPercentage: progress });
      scrolling = false;
    });
  });
  window.addEventListener('wheel', (event) => {
    if (!scrolling) send('did-scroll-wheel', { deltaMode: event.deltaMode, deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ, detail: event.detail, type: event.type });
  });
  const fileDrag = (event: DragEvent) => Boolean(event.dataTransfer?.items.length) && Array.prototype.every.call(event.dataTransfer!.items, (item: DataTransferItem) => item.kind === 'file');
  window.addEventListener('dragenter', (event) => {
    if (!event.defaultPrevented && !event.shiftKey && fileDrag(event)) send('drag-start');
  });
  for (const type of ['dragover', 'drag'] as const) window.addEventListener(type, (event) => {
    event.preventDefault();
    if (fileDrag(event)) send('drag', { shiftKey: event.shiftKey });
  });
  window.addEventListener('drop', (event) => event.preventDefault());
  const postSize = () => send('updated-intrinsic-content-size', { width: document.documentElement.offsetWidth, height: document.documentElement.offsetHeight });
  new ResizeObserver(postSize).observe(document.documentElement);

  // Files added later: images, styles and scripts by URL, and fetch.
  // Only attributes that load a file: src of media, frames and scripts, href of <link>, poster of video.
  const LOADING: Record<string, string[]> = { img: ['src'], script: ['src'], source: ['src'], video: ['src', 'poster'], audio: ['src'], track: ['src'], embed: ['src'], input: ['src'], link: ['href'], image: ['href'] };
  const fix = (element: Element): void => {
    for (const attribute of LOADING[element.tagName.toLowerCase()] ?? []) {
      const value = element.getAttribute(attribute);
      if (!value || value.startsWith('data:')) continue;
      let url: string;
      try {
        url = new URL(value, document.baseURI).toString();
      } catch {
        continue;
      }
      if (!isResource(url)) continue;
      const tag = element.tagName.toLowerCase();
      element.setAttribute(attribute, `data:,`);
      void load(url).then((answer) => {
        if (!answer) return;
        if (tag === 'script') {
          const script = document.createElement('script');
          for (const { name, value: attr } of [...element.attributes]) if (name !== 'src') script.setAttribute(name, attr);
          script.setAttribute('nonce', (element as HTMLScriptElement).nonce || nonce);
          script.textContent = textOf(answer);
          element.replaceWith(script);
        } else if (tag === 'link' && /stylesheet/i.test(element.getAttribute('rel') ?? '')) {
          const style = document.createElement('style');
          style.setAttribute('nonce', (element as HTMLElement).nonce || nonce);
          style.textContent = textOf(answer);
          element.replaceWith(style);
        } else {
          element.setAttribute(attribute, dataUrlOf(answer));
        }
      });
    }
  };
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof Element) fix(record.target);
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        fix(node);
        for (const inner of node.querySelectorAll('[src], link[href], [poster]')) fix(inner);
      }
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href', 'poster'] });
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), document.baseURI).toString();
    if (!isResource(url)) return nativeFetch(input, init);
    const answer = await load(url);
    if (!answer) return new Response('Not Found', { status: 404 });
    return new Response(Uint8Array.from(atob(answer.data), (char) => char.charCodeAt(0)), { status: 200, headers: { 'content-type': answer.mime } });
  }) as typeof fetch;

  // As VS Code does: the content sees itself as the top window.
  for (const [name, value] of [['parent', window], ['top', window], ['frameElement', null]] as const) {
    try {
      Object.defineProperty(window, name, { configurable: true, get: () => value });
    } catch {
      // Not redefinable here; the content still works.
    }
  }
})();
