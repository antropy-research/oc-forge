// The webview host page's side of VS Code's webview protocol that changed
// between releases. Pure, so it is tested without a page.
//
// VS Code 1.143 (webviewElement.ts) takes `webview-ready` only with the mount
// id the workbench put in the host page's URL (`mountId`) and a non-empty
// `keyEventToken`; the key events the page forwards afterwards must carry that
// token, or the workbench drops them instead of running their keybindings.
// VS Code 1.140 ignores both fields.

/** A token for this page's life: 16 random bytes, hex, as VS Code's own host makes it. */
export const createKeyEventToken = (random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)): string => (
  Array.from(random(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')
);

/** The `webview-ready` message, sent with the MessagePort the workbench talks over. */
export const readyMessage = (id: string | null, params: URLSearchParams, keyEventToken: string) => ({
  target: id,
  channel: 'webview-ready',
  data: { keyEventToken, mountId: params.get('mountId') },
});

export const KEY_CHANNELS = new Set(['did-keydown', 'did-keyup']);

/** A key event from this page or its content's agent, as the workbench takes it: with the page's token. */
export const keyEventData = (event: Record<string, unknown>, keyEventToken: string): Record<string, unknown> => ({
  key: event.key,
  keyCode: event.keyCode,
  code: event.code,
  shiftKey: event.shiftKey,
  altKey: event.altKey,
  ctrlKey: event.ctrlKey,
  metaKey: event.metaKey,
  repeat: event.repeat,
  isTrusted: event.isTrusted,
  keyEventToken,
});
