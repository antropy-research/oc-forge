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
  /** The scopes the account granted the Planner; a sign-in adds the ones it asks for. Default: Calendar, Tasks and Gmail. */
  granted?: string[];
  /** A work or school account's Google Workspace domain (its ID token's `hd`); none: a personal account. */
  hostedDomain?: string;
  /** The account's Drive, by name, type and address. */
  driveFiles?: { id: string; name: string; mimeType: string; webViewLink: string; modifiedTime?: string; trashed?: boolean }[];
  /** The account's Gmail messages. */
  mail?: { id: string; threadId: string; subject: string; from: string; date: string; snippet: string; unread?: boolean }[];
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

export const DEFAULT_SCOPES: string[];
export const DRIVE_SCOPE: string;
/** The code a sign-in's redirect carries in this fake: the scopes it asked for (its auth URL's `scope`). */
export function fakeAuthCode(scope: string): string;
export function defaultFakeWorld(options?: { account?: string; today?: string; zone?: string }): FakeWorld;
export function startFakeGoogle(world?: FakeWorld): Promise<FakeGoogle>;
