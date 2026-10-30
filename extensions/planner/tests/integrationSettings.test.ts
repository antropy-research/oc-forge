// Round 12: what the service takes for Sunsama's integration settings (Gmail's automations and email client, Linear's
// import prompt, meeting import, timeboxing channels), a task added from a calendar event, and a task merged in as a
// subtask; anything else is refused before it is written.
import { describe, expect, test } from 'bun:test';
import { validateCommand } from '../src/domain/events.ts';
import { DEFAULT_SETTINGS, emptyState, MEETING_EXCLUSIONS } from '../src/domain/types.ts';
import { applyEvents } from '../src/domain/reducer.ts';

const state = applyEvents(emptyState(), [
  { v: 1, id: 'e1', at: '2026-10-29T00:00:00.000Z', type: 'task.created', task: { id: 't1', title: 'Triage', placement: { kind: 'day', date: '2026-10-29' }, position: 1024 } },
]);
const settings = (patch: Record<string, unknown>) => validateCommand({ cmd: 'c1', type: 'settings.updated', patch }, state);

describe('integration settings', () => {
  test("Sunsama's defaults: no Gmail automations, Gmail as the client, no Linear import prompt, meetings suggested with every exclusion, completed always", () => {
    expect([DEFAULT_SETTINGS.gmailOnImport, DEFAULT_SETTINGS.gmailOnComplete, DEFAULT_SETTINGS.gmailImportPrompt, DEFAULT_SETTINGS.emailClient, DEFAULT_SETTINGS.linearImportPrompt]).toEqual([[], [], false, 'gmail', false]);
    expect([DEFAULT_SETTINGS.meetingImport, DEFAULT_SETTINGS.meetingCalendars, DEFAULT_SETTINGS.meetingExclusions, DEFAULT_SETTINGS.meetingAutoComplete, DEFAULT_SETTINGS.channelTimebox]).toEqual(['prompt', [], [...MEETING_EXCLUSIONS], 'always', {}]);
  });

  test('taken: the values Sunsama offers', () => {
    for (const patch of [
      { gmailOnImport: [{ kind: 'markRead' }, { kind: 'removeLabel', label: 'Inbox' }, { kind: 'addLabel', label: 'In progress' }], gmailOnComplete: [{ kind: 'archive' }], gmailImportPrompt: true, gmailCompletePrompt: false },
      { emailClient: 'superhuman' },
      { linearImportPrompt: true },
      { meetingImport: 'autoSync', meetingCalendars: ['cal-1'], meetingExclusions: ['noAttendees', 'oooHold'], meetingAutoComplete: 'invitees', meetingChannels: { 'cal-1': 'work' } },
      { meetingExclusions: [] },
      { channelTimebox: { personal: { account: 'me@example.com', calendarId: 'family@group.calendar.google.com' } } },
    ]) expect(settings(patch)).toBeNull();
  });

  test('refused: unknown actions, a label action without its label, unknown clients, modes and exclusions, repeats, bad calendars', () => {
    expect(settings({ gmailOnImport: [{ kind: 'delete' }] })).toContain('gmailOnImport must be');
    expect(settings({ gmailOnComplete: [{ kind: 'addLabel' }] })).toContain('gmailOnComplete must be');
    expect(settings({ gmailOnComplete: [{ kind: 'archive', label: 'x' }] })).toContain('gmailOnComplete must be');
    expect(settings({ emailClient: 'outlook' })).toBe('emailClient must be gmail or superhuman');
    expect(settings({ linearImportPrompt: 'yes' })).toBe('linearImportPrompt must be true or false');
    expect(settings({ meetingImport: 'always' })).toBe('meetingImport must be prompt or autoSync');
    expect(settings({ meetingExclusions: ['noAttendees', 'noAttendees'] })).toContain('meetingExclusions must be');
    expect(settings({ meetingExclusions: ['birthdays'] })).toContain('meetingExclusions must be');
    expect(settings({ meetingAutoComplete: 'sometimes' })).toBe('meetingAutoComplete must be always, never or invitees');
    expect(settings({ meetingCalendars: [''] })).toBe('meetingCalendars must be calendar ids');
    expect(settings({ meetingChannels: { 'cal-1': 'not a channel id!' } })).toBe('meetingChannels must map calendar ids to channel ids');
    expect(settings({ channelTimebox: { personal: { account: 'nobody', calendarId: 'x' } } })).toBe('channelTimebox must map channel ids to a Google account and calendar');
  });
});

describe('a task from an event, and a task merged in', () => {
  const event = { kind: 'event', id: 'me@example.com|primary|ev1', key: 'Google Calendar', url: 'https://www.google.com/calendar/event?eid=ev1', title: 'Standup', account: 'me@example.com', event: { calendarId: 'primary', start: '2026-10-29T16:00:00.000Z', end: '2026-10-29T16:15:00.000Z', allDay: false, invitees: true } };
  const created = (source: unknown) => validateCommand({ cmd: 'c2', type: 'task.created', task: { id: 't2', title: 'Standup', placement: { kind: 'day', date: '2026-10-29' }, position: 2048, source } }, state);
  const subtasks = (items: unknown[]) => validateCommand({ cmd: 'c3', type: 'task.updated', taskId: 't1', patch: { subtasks: items } }, state);

  test("an event task keeps its event's times and calendar, and whether it was added by auto-sync", () => {
    expect(created(event)).toBeNull();
    expect(created({ ...event, event: { ...event.event, auto: true } })).toBeNull();
    expect(created({ ...event, event: { ...event.event, start: 'soon' } })).toBe('source is invalid');
    expect(created({ ...event, event: { ...event.event, invitees: 'yes' } })).toBe('source is invalid');
  });

  test('a merged subtask keeps its notes, planned time and link; too long or malformed is refused', () => {
    expect(subtasks([{ id: 's1', title: 'Budget', done: false, notes: 'Numbers', plannedMinutes: 15, source: { kind: 'email', id: 'm1', key: 'Gmail', url: 'https://mail.google.com/mail/u/0/#all/t1', account: 'me@example.com' } }])).toBeNull();
    expect(subtasks([{ id: 's1', title: 'Budget', done: false, plannedMinutes: 15.5 }])).not.toBeNull();
    expect(subtasks([{ id: 's1', title: 'Budget', done: false, notes: 'x'.repeat(40_001) }])).not.toBeNull();
    expect(subtasks([{ id: 's1', title: 'Budget', done: false, source: { kind: 'fax', id: 'x' } }])).not.toBeNull();
  });
});
