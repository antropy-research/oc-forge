// Gmail for Area E's scenarios: a fake Google mailbox (tests/e2e/fakeGoogle.mjs) and a second Google account.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { todayIn } from '../../src/domain/dates.ts';
import { DEFAULT_SCOPES, GMAIL_MODIFY_SCOPE, defaultFakeWorld, type FakeWorld } from '../e2e/fakeGoogle.mjs';
import type { Planner } from './planner.ts';

export const ME = 'harness@example.com';
/** A second account, which allowed Gmail but not its actions. */
export const OTHER = 'other@example.com';
/** A printed message's address names its message as msg-f:<this>; Gmail's API has it in hex. */
export const PRINTED_MESSAGE = '1782345678901234567';
/** Thread ids, as Gmail's API has them (hex). */
export const THREADS = { numbers: '18b2f3c4d5e6f700', lunch: BigInt(PRINTED_MESSAGE).toString(16), triage: '18c0000000000a00', budget: '18c0000000000b00', trip: '18c0000000000c00' } as const;

/** The default fake Google in `zone`, signed in as ME with Gmail actions, a label of the user's and a few threads. */
export const mailWorld = (zone: string): FakeWorld => {
  const world = defaultFakeWorld({ account: ME, today: todayIn(zone), zone });
  world.granted = [...DEFAULT_SCOPES, GMAIL_MODIFY_SCOPE];
  world.mailLabels = [{ id: 'Label_7', name: 'In progress' }];
  const mail = (id: string, threadId: string, subject: string, from: string, date: string, snippet: string, unread = true, body?: string) => ({ id, threadId, subject, from, date, snippet, unread, ...(body ? { body } : {}) });
  world.mail = [
    mail('18b2f3c4d5e6f701', THREADS.numbers, 'Quarterly numbers', 'Ann Lee <ann@example.com>', '2026-10-28T09:00:00.000Z', 'First draft', false, 'Hi,\nthe first draft.'),
    mail('18b2f3c4d5e6f702', THREADS.numbers, 'Re: Quarterly numbers', 'Bo <bo@example.com>', '2026-10-29T10:00:00.000Z', 'Looks good'),
    mail(THREADS.lunch, THREADS.lunch, 'Lunch?', 'Cy <cy@example.com>', '2026-10-29T11:00:00.000Z', 'Tacos'),
    mail('18c0000000000a01', THREADS.triage, 'Inbox triage', 'Dee <dee@example.com>', '2026-10-29T12:00:00.000Z', 'The week'),
    mail('18c0000000000b01', THREADS.budget, 'Budget', 'Ed <ed@example.com>', '2026-10-29T13:00:00.000Z', 'Numbers'),
    mail('18c0000000000c01', THREADS.trip, 'Trip', 'Flo <flo@example.com>', '2026-10-29T14:00:00.000Z', 'Tickets'),
  ];
  return world;
};

/** Labels a message has in the fake Gmail now (Gmail's ids: INBOX, UNREAD, Label_7…), sorted. */
export const labelsOf = (planner: Planner, messageId: string): string[] => {
  const message = planner.google!.world.mail!.find((item) => item.id === messageId)!;
  return [...(message.labels ?? (message.unread ? ['UNREAD', 'INBOX'] : ['INBOX']))].sort();
};

/** Gmail label changes the fake was asked for on a thread (modify or trash). */
export const threadActs = (planner: Planner, thread: string): number => planner.google!.requests.filter((request) => request.path.startsWith(`/gmail/v1/users/me/threads/${thread}/`)).length;

/** OTHER signed in beside ME, with Gmail but not its actions: written into the service's accounts and read on a restart. */
export const addSecondAccount = async (planner: Planner): Promise<void> => {
  const file = join(planner.home, 'google-accounts.json');
  const accounts = JSON.parse(readFileSync(file, 'utf8'));
  accounts.accounts.push({ ...accounts.accounts[0], email: OTHER, scopes: DEFAULT_SCOPES });
  writeFileSync(file, JSON.stringify(accounts), { mode: 0o600 });
  await planner.restart();
};
