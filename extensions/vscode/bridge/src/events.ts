// A minimal event, shaped as VS Code's (`vscode.Event`): the bridge's pure parts use it without the `vscode` module.

export interface Disposable {
  dispose(): void;
}

export type Event<T> = (listener: (value: T) => void) => Disposable;

export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch {
        // A listener's error is its own.
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls an asynchronous `probe` every `every` ms until it is truthy or `timeoutMs` passed. */
export const waitForAsync = async (probe: () => PromiseLike<boolean>, timeoutMs: number, every = 50): Promise<boolean> => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() >= end) return false;
    await sleep(every);
  }
};

/** Polls `probe` every `every` ms until it is truthy or `timeoutMs` passed. */
export const waitFor = async (probe: () => boolean, timeoutMs: number, every = 50): Promise<boolean> => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (probe()) return true;
    if (Date.now() >= end) return false;
    await sleep(every);
  }
};
