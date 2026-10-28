// The extension side of oc-forge's OpenChamber APIs. Bundle it into a panel
// or page frame next to `@openchamber/sdk`:
//
//   import { connectOcForge } from '../../../adapters/openchamber/client/index.ts';
//   const forge = await connectOcForge();      // null on a stock OpenChamber
//   if (forge?.has('tabs')) await forge.tabs.open({ id: 'file:///a.ts', title: 'a.ts' }, { activate: true });
//
// It has no dependencies. Everything it sends travels on its own postMessage
// channel, which a stock OpenChamber ignores, so `connectOcForge` resolving
// null is the whole feature detection: keep the stock behaviour then.
import {
  envelope,
  matchHostShortcut,
  readOcForgeEvent,
  type OcForgeEvent,
  type OcForgeFeature,
  type OcForgeForwardableAction,
  type OcForgeHello,
  type OcForgeKey,
  type OcForgeShortcuts,
  type OcForgeTab,
  type OcForgeTabsState,
} from '../host/protocol.ts';

export * from '../host/protocol.ts';

export type OcForgeClient = {
  /** The host's announcement for this frame. */
  readonly hello: OcForgeHello;
  has(feature: OcForgeFeature): boolean;
  rail: {
    /** The entry this rail panel shows (its own entry for an entry's own panel); null without entries. */
    entry(): string | null;
    /** This frame is a rail entry's own panel (`zone` entries), not the extension's one panel. */
    own(): boolean;
    /** The user picked another entry of this panel on the rail. */
    onEntry(listener: (entry: string) => void): () => void;
    /** The panel switched entries by itself (its own navigation): move the rail's highlight. */
    setActive(entry: string): Promise<void>;
  };
  tabs: {
    state(): OcForgeTabsState;
    /** Opens or updates a header tab; `activate` shows the extension's page on it. */
    open(tab: OcForgeTab, options?: { activate?: boolean }): Promise<void>;
    update(id: string, patch: { title?: string; icon?: string | null; dirty?: boolean }): Promise<void>;
    close(id: string): Promise<void>;
    activate(id: string): Promise<void>;
    /** The user chose this tab (the page now shows it). */
    onActivate(listener: (id: string) => void): () => void;
    /** The user closed this tab in the header; it is already gone there. */
    onClose(listener: (id: string) => void): () => void;
    /**
     * While this has a listener, a dirty tab the user closes (its ×, its menu,
     * the close-tab key) stays open and its page shows it; the listener gets
     * the id and runs the extension's own flow (a save prompt), then calls
     * `close(id)` if the tab really closes, or leaves it. Clean tabs, and every
     * tab while nothing listens, close at once (`onClose`).
     */
    onCloseRequest(listener: (id: string) => void): () => void;
    onChange(listener: (state: OcForgeTabsState) => void): () => void;
  };
  keys: {
    shortcuts(): OcForgeShortcuts;
    /** The OpenChamber navigation action this press is bound to, if any. */
    match(event: KeyboardEvent | OcForgeKey): OcForgeForwardableAction | null;
    /** Hands a press to OpenChamber; call it while handling the press (it needs the user activation). */
    forward(event: KeyboardEvent | OcForgeKey): Promise<OcForgeForwardableAction>;
    /**
     * Forwards every press bound to an OpenChamber navigation action, and keeps
     * it from the frame (and from the browser). `except` keeps some for the frame.
     */
    forwardHostShortcuts(options?: {
      except?: readonly OcForgeForwardableAction[] | ((action: OcForgeForwardableAction, event: KeyboardEvent) => boolean);
      /** Each press taken for OpenChamber, and whether the host ran it (the promise rejects when it refused). */
      onForward?: (action: OcForgeForwardableAction, outcome: Promise<OcForgeForwardableAction>) => void;
    }): () => void;
    onChange(listener: (shortcuts: OcForgeShortcuts) => void): () => void;
  };
  links: {
    /** This extension's page on `route`, as an absolute URL for `<a href>` (null where the host has none). */
    pageUrl(route?: string): string | null;
    /** A chat's URL. */
    sessionUrl(sessionId: string): string | null;
    /** The route this frame was handed (a deep link, back/forward), if any. */
    route(): string | null;
    onRoute(listener: (route: string) => void): () => void;
    /** The page's own route: kept in the address bar while the page shows. `push` adds a history entry. */
    setRoute(route: string, options?: { push?: boolean }): Promise<void>;
  };
  dispose(): void;
};

type Listener<T> = (value: T) => void;
type Pending = { resolve: (payload: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

const REQUEST_TIMEOUT_MS = 10_000;

const keyOf = (event: KeyboardEvent | OcForgeKey): OcForgeKey => ({
  key: event.key,
  code: event.code,
  ctrlKey: event.ctrlKey,
  metaKey: event.metaKey,
  altKey: event.altKey,
  shiftKey: event.shiftKey,
  repeat: event.repeat === true,
});

const emit = <T,>(listeners: Set<Listener<T>>, value: T): void => {
  for (const listener of listeners) {
    try {
      listener(value);
    } catch (error) {
      console.error(error);
    }
  }
};

const subscribe = <T,>(listeners: Set<Listener<T>>, listener: Listener<T>): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Says hello on the oc-forge channel and resolves with the client once the
 * host answers, or null when it does not within `timeoutMs` (a stock
 * OpenChamber, or a page outside a frame).
 */
export const connectOcForge = (options: { timeoutMs?: number; target?: Window } = {}): Promise<OcForgeClient | null> => {
  const target = options.target ?? (typeof window === 'undefined' ? null : window);
  if (!target || target.parent === target) return Promise.resolve(null);
  const host = target.parent;
  return new Promise((resolveClient) => {
    let hello: OcForgeHello | null = null;
    let disposed = false;
    let ids = 0;
    const pending = new Map<string, Pending>();
    const entryListeners = new Set<Listener<string>>();
    const activateListeners = new Set<Listener<string>>();
    const closeListeners = new Set<Listener<string>>();
    const closeRequestListeners = new Set<Listener<string>>();
    const tabsListeners = new Set<Listener<OcForgeTabsState>>();
    const routeListeners = new Set<Listener<string>>();
    const shortcutListeners = new Set<Listener<OcForgeShortcuts>>();

    const post = (type: string, payload?: unknown, id?: string): void => {
      host.postMessage(envelope(payload === undefined ? { type } : { type, payload }, id), '*');
    };

    const request = (type: string, payload?: unknown): Promise<unknown> => {
      if (disposed) return Promise.reject(new Error('oc-forge client is disposed.'));
      return new Promise((resolve, reject) => {
        ids += 1;
        const id = `oc-forge-${ids}`;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('OpenChamber did not answer in time.'));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        post(type, payload, id);
      });
    };

    const state = () => hello as OcForgeHello;

    const forward = async (event: KeyboardEvent | OcForgeKey): Promise<OcForgeForwardableAction> => {
      const answer = await request('key', keyOf(event)) as { action: OcForgeForwardableAction };
      return answer.action;
    };

    const client: OcForgeClient = {
      get hello() {
        return state();
      },
      has: (feature) => state().features.includes(feature),
      rail: {
        entry: () => state().rail?.entry ?? null,
        own: () => state().rail?.own ?? false,
        onEntry: (listener) => subscribe(entryListeners, listener),
        setActive: async (entry) => {
          await request('rail-active', { entry });
          if (hello?.rail) hello = { ...hello, rail: { ...hello.rail, entry } };
        },
      },
      tabs: {
        state: () => state().tabs,
        open: async (tab, { activate } = {}) => {
          await request('tab-open', activate === undefined ? tab : { ...tab, activate });
        },
        update: async (id, patch) => {
          await request('tab-update', { id, ...patch });
        },
        close: async (id) => {
          await request('tab-close', { id });
        },
        activate: async (id) => {
          await request('tab-activate', { id });
        },
        onActivate: (listener) => subscribe(activateListeners, listener),
        onClose: (listener) => subscribe(closeListeners, listener),
        onCloseRequest: (listener) => {
          if (closeRequestListeners.size === 0) post('tab-close-handler', { on: true });
          const unsubscribe = subscribe(closeRequestListeners, listener);
          return () => {
            const had = closeRequestListeners.size > 0;
            unsubscribe();
            if (had && closeRequestListeners.size === 0) post('tab-close-handler', { on: false });
          };
        },
        onChange: (listener) => subscribe(tabsListeners, listener),
      },
      keys: {
        shortcuts: () => state().shortcuts,
        match: (event) => matchHostShortcut(keyOf(event), state().shortcuts),
        forward,
        forwardHostShortcuts: ({ except, onForward } = {}) => {
          const keeps = (action: OcForgeForwardableAction, event: KeyboardEvent): boolean => (
            typeof except === 'function' ? except(action, event) : Boolean(except?.includes(action))
          );
          const onKeyDown = (event: KeyboardEvent) => {
            if (event.isComposing || event.defaultPrevented) return;
            const action = matchHostShortcut(keyOf(event), state().shortcuts);
            if (!action || keeps(action, event)) return;
            // Taken before the frame's own handlers, and before the browser
            // (Cmd/Ctrl+digit would otherwise switch browser tabs).
            event.preventDefault();
            event.stopImmediatePropagation();
            const outcome = forward(event);
            outcome.catch(() => undefined);
            onForward?.(action, outcome);
          };
          target.addEventListener('keydown', onKeyDown, true);
          return () => target.removeEventListener('keydown', onKeyDown, true);
        },
        onChange: (listener) => subscribe(shortcutListeners, listener),
      },
      links: {
        pageUrl: (route = '') => (state().links ? `${state().links!.page}${encodeURIComponent(route)}` : null),
        sessionUrl: (sessionId) => (state().links ? `${state().links!.session}${encodeURIComponent(sessionId)}` : null),
        route: () => state().route,
        onRoute: (listener) => subscribe(routeListeners, listener),
        setRoute: async (route, { push } = {}) => {
          await request('route', push === undefined ? { route } : { route, push });
          if (hello) hello = { ...hello, route };
        },
      },
      dispose: () => {
        disposed = true;
        target.removeEventListener('message', onMessage);
        for (const waiter of pending.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error('oc-forge client is disposed.'));
        }
        pending.clear();
      },
    };

    const handle = (event: OcForgeEvent): void => {
      switch (event.type) {
        case 'hello': {
          const first = hello === null;
          hello = event.payload;
          if (first) resolveClient(client);
          return;
        }
        case 'result': {
          const waiter = pending.get(event.id);
          if (!waiter) return;
          clearTimeout(waiter.timer);
          pending.delete(event.id);
          if (event.ok) waiter.resolve(event.payload);
          else waiter.reject(new Error(event.error ?? 'OpenChamber refused the request.'));
          return;
        }
        default:
          break;
      }
      if (!hello) return;
      switch (event.type) {
        case 'rail-entry':
          if (hello.rail) hello = { ...hello, rail: { ...hello.rail, entry: event.payload.entry } };
          emit(entryListeners, event.payload.entry);
          return;
        case 'tab-activated':
          hello = { ...hello, tabs: { ...hello.tabs, active: event.payload.id } };
          emit(activateListeners, event.payload.id);
          return;
        case 'tab-closed':
          emit(closeListeners, event.payload.id);
          return;
        case 'tab-close-request':
          emit(closeRequestListeners, event.payload.id);
          return;
        case 'tabs':
          hello = { ...hello, tabs: event.payload };
          emit(tabsListeners, event.payload);
          return;
        case 'route':
          hello = { ...hello, route: event.payload.route };
          emit(routeListeners, event.payload.route);
          return;
        case 'shortcuts':
          hello = { ...hello, shortcuts: event.payload };
          emit(shortcutListeners, event.payload);
          return;
        default:
          return;
      }
    };

    function onMessage(event: MessageEvent): void {
      if (event.source !== host) return;
      const message = readOcForgeEvent(event.data);
      if (message) handle(message);
    }

    target.addEventListener('message', onMessage);
    post('hello');
    setTimeout(() => {
      if (hello) return;
      disposed = true;
      target.removeEventListener('message', onMessage);
      resolveClient(null);
    }, options.timeoutMs ?? 1500);
  });
};
