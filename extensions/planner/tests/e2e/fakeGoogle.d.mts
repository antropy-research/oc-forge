// Types for fakeGoogle.mjs, so the TypeScript tests can use it.
export interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: any;
  at: number;
}

export interface FakeWorld {
  account: string;
  zone: string;
  pageSize: Record<string, number>;
  calendars: { id: string; summary: string; accessRole: string; backgroundColor: string; primary?: boolean }[];
  events: Record<string, any[]>;
  lists: { id: string; title: string }[];
  defaultList: string;
  tasks: Record<string, any[]>;
}

export interface FakeGoogle {
  base: string;
  requests: FakeRequest[];
  world: FakeWorld;
  calendars: Map<string, { events: Map<string, any>; exceptions: Map<string, any> }>;
  tasks: Map<string, any[]>;
  lists: { id: string; title: string }[];
  failNext(method: string, path: string, status: number, message: string): void;
  delayNext(method: string, path: string, ms: number, times?: number): void;
  accountsFile(): string;
  close(): Promise<void>;
}

export function defaultFakeWorld(options?: { account?: string; today?: string; zone?: string }): FakeWorld;
export function startFakeGoogle(world?: FakeWorld): Promise<FakeGoogle>;
