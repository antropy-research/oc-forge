// What an OpenChamber extension frame lacks and VS Code's workbench expects. The
// frame is sandboxed without allow-same-origin: its origin is opaque, so
// localStorage, sessionStorage, cookies and IndexedDB throw; a module worker
// cannot start from a blob: URL; its CSP lets it reach only its own package,
// so the VS Code Server's resources and the extension gallery come through the
// extension's service; and it may not open windows.

export interface ShimOptions {
  /** The workbench's remote authority: URLs on it are the VS Code Server's. */
  authority: string;
  /** Path and query on the VS Code Server → its answer. */
  serverGet: (path: string) => Promise<Answer>;
  /** An allowed external URL (gallery, CDN) → its answer; null when not allowed. */
  externalFetch: (url: string, init: { method: string; headers: Record<string, string>; body: string | null }) => Promise<Answer> | null;
  /** Whether the service may fetch this external URL. */
  isExternal: (url: string) => boolean;
  /** Open a link outside the frame. */
  openUrl: (url: string) => void;
}

export interface Answer {
  status: number;
  contentType: string;
  /** Base64. */
  data: string;
}

const memoryStorage = (): Storage => {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(String(key)) ?? null,
    setItem: (key: string, value: string) => void map.set(String(key), String(value)),
    removeItem: (key: string) => void map.delete(String(key)),
    clear: () => map.clear(),
  } as Storage;
};

/** Storage, cookies and window.open: synchronous, before anything else runs. */
export const installBasicShims = (openUrl: (url: string) => void): void => {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    let works = false;
    try {
      works = Boolean(window[name]);
    } catch {
      works = false;
    }
    if (!works) {
      const storage = memoryStorage();
      Object.defineProperty(window, name, { configurable: true, get: () => storage });
    }
  }
  try {
    void document.cookie;
  } catch {
    let jar = '';
    Object.defineProperty(document, 'cookie', { configurable: true, get: () => jar, set: (value: string) => void (jar = String(value).split(';')[0] ?? '') });
  }
  window.open = ((url?: string | URL) => {
    const href = url ? String(url) : '';
    if (/^https?:\/\//i.test(href)) openUrl(href);
    return null;
  }) as typeof window.open;
};

/**
 * Module workers: VS Code starts each worker as a module from a blob: URL it
 * builds (a bootstrap that imports the worker's script). An opaque-origin frame
 * cannot start a module worker from a blob: URL but can from a data: URL, so
 * the bootstrap's text is kept when its Blob is made and the worker starts from
 * that text instead.
 */
export const installWorkerShim = (): void => {
  const texts = new WeakMap<Blob, string>();
  const urls = new Map<string, string>();
  const NativeBlob = window.Blob;
  class ScriptBlob extends NativeBlob {
    constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
      super(parts, options);
      if (parts && /javascript|ecmascript/i.test(options?.type ?? '') && parts.every((part) => typeof part === 'string')) texts.set(this, (parts as string[]).join(''));
    }
  }
  window.Blob = ScriptBlob as typeof Blob;
  const createObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (object: Blob | MediaSource) => {
    const url = createObjectURL(object);
    const text = object instanceof NativeBlob ? texts.get(object) : undefined;
    if (text !== undefined) urls.set(url, text);
    return url;
  };
  const revokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = (url: string) => {
    // A worker may still be starting from it; the text is small next to what it loads.
    revokeObjectURL(url);
  };
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      const href = String(url);
      const text = options?.type === 'module' && href.startsWith('blob:') ? urls.get(href) : undefined;
      super(text !== undefined ? `data:text/javascript;charset=utf-8,${encodeURIComponent(text)}` : url, options);
    }
  } as typeof Worker;
};

const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
};
const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

const responseOf = (answer: Answer): Response => {
  const status = answer.status >= 200 && answer.status <= 599 ? answer.status : 502;
  const empty = status === 204 || status === 205 || status === 304;
  return new Response(empty ? null : fromBase64(answer.data), { status, headers: { 'content-type': answer.contentType } });
};

/**
 * Requests to the VS Code Server and the gallery, through the service: fetch
 * directly, and images and CSS (icon fonts, extension icons) by turning their
 * URLs into blob: URLs of what the service fetched.
 */
export const installResourceBridge = (options: ShimOptions): void => {
  const serverPath = (url: string): string | null => {
    try {
      const parsed = new URL(url, document.baseURI);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === options.authority ? `${parsed.pathname}${parsed.search}` : null;
    } catch {
      return null;
    }
  };
  const bridged = (url: string): boolean => serverPath(url) !== null || options.isExternal(url);

  const nativeFetch = window.fetch.bind(window);
  const answerFor = async (url: string, init?: RequestInit): Promise<Answer | null> => {
    const path = serverPath(url);
    if (path !== null) return options.serverGet(path);
    if (!options.isExternal(url)) return null;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    let body: string | null = null;
    if (init?.body !== undefined && init.body !== null) {
      const raw = init.body;
      body = typeof raw === 'string' ? btoa(unescape(encodeURIComponent(raw))) : raw instanceof Uint8Array ? toBase64(raw) : raw instanceof ArrayBuffer ? toBase64(new Uint8Array(raw)) : null;
    }
    return options.externalFetch(url, { method: (init?.method ?? 'GET').toUpperCase(), headers, body });
  };
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!bridged(url)) return nativeFetch(input, init);
    const request = input instanceof Request ? { method: input.method, headers: input.headers, body: init?.body ?? (input.method === 'GET' ? undefined : await input.text()) } : init;
    const answer = await answerFor(url, request as RequestInit | undefined);
    if (!answer) return nativeFetch(input, init);
    return responseOf(answer);
  }) as typeof fetch;

  const blobUrls = new Map<string, Promise<string>>();
  /** The blob URL of each server URL fetched already, to put in at once. */
  const ready = new Map<string, string>();
  const blobUrlOf = (url: string): Promise<string> => {
    let promise = blobUrls.get(url);
    if (!promise) {
      promise = answerFor(url).then((answer) => {
        if (!answer || answer.status >= 400) return url;
        const blob = URL.createObjectURL(new Blob([fromBase64(answer.data)], { type: answer.contentType }));
        ready.set(url, blob);
        return blob;
      }).catch(() => url);
      blobUrls.set(url, promise);
    }
    return promise;
  };
  // What stands in for a server URL until its blob is there: the browser never asks the server itself, which the
  // frame's Content Security Policy refuses (a console error, and a check's), only to show the blob a moment later.
  const PENDING = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const shownNow = (url: string): string => ready.get(url) ?? PENDING;
  const URL_IN_CSS = /url\(\s*(['"]?)((?:\\.|[^'"\\)])+)\1\s*\)/g;
  // VS Code writes URLs into CSS escaped (`asCSSUrl`): `http\:\/\/host\:8000\/…`.
  const cssUnescape = (value: string): string => value.replace(/\\([0-9a-fA-F]{1,6}\s?|[\s\S])/g, (_whole, escaped: string) => (/^[0-9a-fA-F]/.test(escaped) && escaped.trim().length > 0 && /^[0-9a-fA-F]+\s?$/.test(escaped) ? String.fromCodePoint(Number.parseInt(escaped.trim(), 16)) : escaped));
  const cssUrls = (text: string): string[] => [...text.matchAll(URL_IN_CSS)].map((match) => cssUnescape(match[2]!)).filter(bridged);
  const rewriteCss = async (text: string): Promise<string> => {
    const found = [...new Set(cssUrls(text))];
    if (found.length === 0) return text;
    const replacements = new Map(await Promise.all(found.map(async (url) => [url, await blobUrlOf(url)] as const)));
    return text.replace(URL_IN_CSS, (whole, quote: string, raw: string) => {
      const url = cssUnescape(raw);
      return replacements.has(url) && replacements.get(url) !== url ? `url("${replacements.get(url)}")` : whole;
    });
  };
  /** The CSS as it can show now: each server URL its blob's if fetched already, else the stand-in. */
  const cssNow = (text: string): string => text.replace(URL_IN_CSS, (whole, _quote: string, raw: string) => {
    const url = cssUnescape(raw);
    return bridged(url) ? `url("${shownNow(url)}")` : whole;
  });

  // Each is changed at once (the observer runs before the browser paints or fetches what was put in), then again
  // once the blobs are there, unless something else changed it meanwhile.
  const fixImage = (image: HTMLImageElement): void => {
    const src = image.getAttribute('src');
    if (!src || !bridged(src)) return;
    const now = shownNow(src);
    image.setAttribute('src', now);
    if (now === PENDING) void blobUrlOf(src).then((blob) => {
      if (image.getAttribute('src') === now && blob !== src) image.setAttribute('src', blob);
    });
  };
  const fixStyleElement = (style: HTMLStyleElement): void => {
    const text = style.textContent ?? '';
    if (!cssUrls(text).length) return;
    const now = cssNow(text);
    style.textContent = now;
    if (now.includes(PENDING)) void rewriteCss(text).then((next) => {
      if (style.textContent === now && next !== text) style.textContent = next;
    });
  };
  const fixInlineStyle = (element: HTMLElement): void => {
    const text = element.getAttribute('style') ?? '';
    if (!cssUrls(text).length) return;
    const now = cssNow(text);
    element.setAttribute('style', now);
    if (now.includes(PENDING)) void rewriteCss(text).then((next) => {
      if (element.getAttribute('style') === now && next !== text) element.setAttribute('style', next);
    });
  };
  const visit = (node: Node): void => {
    if (!(node instanceof Element)) return;
    if (node instanceof HTMLImageElement) fixImage(node);
    else if (node instanceof HTMLStyleElement) fixStyleElement(node);
    if (node instanceof HTMLElement && node.hasAttribute('style')) fixInlineStyle(node);
    for (const image of node.querySelectorAll('img[src]')) fixImage(image as HTMLImageElement);
    for (const style of node.querySelectorAll('style')) fixStyleElement(style);
    for (const styled of node.querySelectorAll('[style*="url("]')) fixInlineStyle(styled as HTMLElement);
  };
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'childList') {
        for (const node of record.addedNodes) visit(node);
        if (record.target instanceof HTMLStyleElement) fixStyleElement(record.target);
      } else if (record.type === 'characterData' && record.target.parentNode instanceof HTMLStyleElement) {
        fixStyleElement(record.target.parentNode);
      } else if (record.type === 'attributes' && record.target instanceof HTMLElement) {
        if (record.attributeName === 'src' && record.target instanceof HTMLImageElement) fixImage(record.target);
        else if (record.attributeName === 'style') fixInlineStyle(record.target);
      }
    }
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['src', 'style'] });

  // A URL set on an element's style through the CSSOM (an icon label's `style.backgroundImage = asCSSUrl(icon)`, an
  // extension's icon in a tab or a tree) is in place before the observer runs, and a layout read right after it in the
  // same task makes the browser load it: such a value is rewritten as it is set, the blob put in once it is there.
  const swapLater = (read: () => string, write: (value: string) => void, original: string): void => {
    const shown = read();
    void rewriteCss(original).then((next) => {
      if (read() === shown && next !== original) write(next);
    });
  };
  let styleProto: object | null = Object.getPrototypeOf(document.documentElement.style);
  while (styleProto && !Object.getOwnPropertyDescriptor(styleProto, 'backgroundImage')) styleProto = Object.getPrototypeOf(styleProto);
  for (const property of ['background', 'backgroundImage', 'mask', 'maskImage', 'webkitMask', 'webkitMaskImage', 'listStyleImage', 'borderImage', 'borderImageSource', 'content', 'cursor']) {
    const descriptor = styleProto ? Object.getOwnPropertyDescriptor(styleProto, property) : undefined;
    if (!styleProto || !descriptor?.get || !descriptor.set || !descriptor.configurable) continue;
    const { get, set } = descriptor;
    Object.defineProperty(styleProto, property, {
      ...descriptor,
      set(this: CSSStyleDeclaration, value: unknown) {
        if (typeof value !== 'string' || !cssUrls(value).length) return set.call(this, value);
        const now = cssNow(value);
        set.call(this, now);
        if (now.includes(PENDING)) swapLater(() => String(get.call(this)), (next) => set.call(this, next), value);
      },
    });
  }
  const setProperty = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function (this: CSSStyleDeclaration, name: string, value: string | null, priority?: string): void {
    if (typeof value !== 'string' || !cssUrls(value).length) return setProperty.call(this, name, value, priority);
    const now = cssNow(value);
    setProperty.call(this, name, now, priority);
    if (now.includes(PENDING)) swapLater(() => this.getPropertyValue(name), (next) => setProperty.call(this, name, next, priority), value);
  };

  // Rules added through the CSSOM (VS Code's createCSSRule) never show in the DOM.
  const insertRule = CSSStyleSheet.prototype.insertRule;
  CSSStyleSheet.prototype.insertRule = function (this: CSSStyleSheet, rule: string, index?: number): number {
    if (!cssUrls(rule).length) return insertRule.call(this, rule, index);
    const shown = cssNow(rule);
    const at = insertRule.call(this, shown, index);
    if (shown.includes(PENDING)) {
      const inserted = this.cssRules[at];
      void rewriteCss(rule).then((next) => {
        const now = [...this.cssRules].indexOf(inserted as CSSRule);
        if (now < 0 || next === rule) return;
        this.deleteRule(now);
        insertRule.call(this, next, now);
      });
    }
    return at;
  };
};
