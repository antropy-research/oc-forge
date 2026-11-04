import { describe, expect, test } from 'bun:test';
import { checkEventInput, descriptionText, eventBody, planDelete, planEdit, planRsvp, type EventPlan } from '../src/domain/gevents.ts';
import { eventDetail, type RawGoogleEvent } from '../src/domain/google.ts';

const LA = 'America/Los_Angeles';
type Identified = RawGoogleEvent & { id: string };

const guests = [
  { email: 'me@x.com', self: true, organizer: true, responseStatus: 'accepted' },
  { email: 'ann@x.com', displayName: 'Ann', responseStatus: 'accepted' },
];
/** Team sync, Mondays 9–10 since October 5, 2026. */
const series: Identified = {
  id: 'wk',
  summary: 'Team sync',
  description: 'Agenda',
  start: { dateTime: '2026-10-05T09:00:00-07:00', timeZone: LA },
  end: { dateTime: '2026-10-05T10:00:00-07:00', timeZone: LA },
  recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
  attendees: guests,
  reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
};
const occurrence = (date: string): Identified => ({
  id: `wk_${date.replace(/-/g, '')}T160000Z`,
  recurringEventId: 'wk',
  summary: 'Team sync',
  originalStartTime: { dateTime: `${date}T09:00:00-07:00`, timeZone: LA },
  start: { dateTime: `${date}T09:00:00-07:00`, timeZone: LA },
  end: { dateTime: `${date}T10:00:00-07:00`, timeZone: LA },
  attendees: guests,
});
const ops = (plan: EventPlan) => {
  if ('error' in plan) throw new Error(plan.error);
  return plan.ops;
};

describe('what may be sent to Google', () => {
  test('inputs are checked before anything is sent', () => {
    const start = { dateTime: '2026-10-26T16:00:00Z' };
    const end = { dateTime: '2026-10-26T17:00:00Z' };
    expect(checkEventInput({ summary: 'x', start, end }, true)).toBeNull();
    expect(checkEventInput({ summary: 'x' }, true)).toContain('start and an end');
    expect(checkEventInput({ summary: 'x' }, false)).toBeNull();
    expect(checkEventInput({ start: end, end: start }, false)).toContain('end after it starts');
    expect(checkEventInput({ start: { date: '2026-10-26' }, end }, false)).toContain('both be days');
    expect(checkEventInput({ start: { date: '2026-10-26' }, end: { date: '2026-10-27' } }, false)).toBeNull();
    expect(checkEventInput({ start: { dateTime: '2026-10-26T16:00:00Z', timeZone: 'Mars/Olympus' }, end }, false)).toContain('both be days');
    expect(checkEventInput({ attendees: [{ email: 'not an email' }] }, false)).toContain('not an email');
    expect(checkEventInput({ colorId: '12' }, false)).toContain('color');
    expect(checkEventInput({ recurrence: ['FREQ=DAILY'] }, false)).toContain('RRULE');
    expect(checkEventInput({ reminders: { useDefault: false, overrides: [{ method: 'sms', minutes: 10 }] } }, false)).toContain('notification');
    expect(checkEventInput({ eventType: 'focusTime' }, false)).toContain('unknown event field');
  });

  test('guests who stay keep their answers; the organizer stays; a Meet call is asked for', () => {
    const { body, conference } = eventBody({ attendees: [{ email: 'ann@x.com' }, { email: 'bob@x.com', optional: true }], meet: true, colorId: '11' }, series, 'req-1');
    expect(body.attendees).toEqual([guests[0], guests[1], { email: 'bob@x.com', optional: true }]);
    expect(body.conferenceData).toEqual({ createRequest: { requestId: 'req-1', conferenceSolutionKey: { type: 'hangoutsMeet' } } });
    expect([conference, body.colorId]).toEqual([true, '11']);
    expect(eventBody({ attendees: [] }, series, 'r').body.attendees).toEqual([guests[0]]);
    expect(eventBody({ meet: false }, { ...series, hangoutLink: 'https://meet.google.com/x' }, 'r')).toEqual({ body: { conferenceData: null }, conference: true });
    expect(eventBody({ reminders: { useDefault: true, overrides: [{ method: 'popup', minutes: 5 }] } }, null, 'r').body.reminders).toEqual({ useDefault: true });
  });
});

describe('changing a recurring event', () => {
  test('a single event is patched, whatever the scope', () => {
    expect(ops(planEdit({ scope: 'all', instance: { id: 'one', start: series.start, end: series.end }, series: null, input: { summary: 'Retro' }, zone: LA, requestId: 'r' }))).toEqual([
      { method: 'PATCH', eventId: 'one', body: { summary: 'Retro' }, conference: false, role: 'change' },
    ]);
  });

  test('This event: the occurrence alone, and never its own repeat rule', () => {
    const moved = { start: { dateTime: '2026-10-26T10:00:00-07:00', timeZone: LA }, end: { dateTime: '2026-10-26T11:00:00-07:00', timeZone: LA } };
    expect(ops(planEdit({ scope: 'this', instance: occurrence('2026-10-26'), series, input: moved, zone: LA, requestId: 'r' }))).toEqual([{ method: 'PATCH', eventId: 'wk_20261026T160000Z', body: moved, conference: false, role: 'change' }]);
    expect(planEdit({ scope: 'this', instance: occurrence('2026-10-26'), series, input: { recurrence: ['RRULE:FREQ=DAILY'] }, zone: LA, requestId: 'r' })).toMatchObject({ error: expect.stringContaining('This and following') });
  });

  test('All events: a new clock time moves the series’ own start', () => {
    const [op] = ops(planEdit({ scope: 'all', instance: occurrence('2026-10-26'), series, input: { start: { dateTime: '2026-10-26T10:30:00-07:00', timeZone: LA }, end: { dateTime: '2026-10-26T12:00:00-07:00', timeZone: LA } }, zone: LA, requestId: 'r' }));
    expect(op).toEqual({ method: 'PATCH', eventId: 'wk', body: { start: { dateTime: '2026-10-05T17:30:00.000Z', timeZone: LA }, end: { dateTime: '2026-10-05T19:00:00.000Z', timeZone: LA } }, conference: false, role: 'change' });
  });

  test('All events: a move to another day moves the series and its weekday', () => {
    const [op] = ops(planEdit({ scope: 'all', instance: occurrence('2026-10-26'), series, input: { start: { dateTime: '2026-10-27T09:00:00-07:00', timeZone: LA }, end: { dateTime: '2026-10-27T10:00:00-07:00', timeZone: LA } }, zone: LA, requestId: 'r' }));
    expect(op!.body).toEqual({ start: { dateTime: '2026-10-06T16:00:00.000Z', timeZone: LA }, end: { dateTime: '2026-10-06T17:00:00.000Z', timeZone: LA }, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'] });
    // The same times as before change nothing about when it happens.
    const [same] = ops(planEdit({ scope: 'all', instance: occurrence('2026-10-26'), series, input: { summary: 'Weekly sync', start: occurrence('2026-10-26').start, end: occurrence('2026-10-26').end }, zone: LA, requestId: 'r' }));
    expect(same!.body).toEqual({ summary: 'Weekly sync' });
  });

  test('This and following: the series ends the second before, a new series starts here with the change', () => {
    const plan = ops(planEdit({ scope: 'following', instance: occurrence('2026-10-26'), series, input: { summary: 'New sync', start: { dateTime: '2026-10-26T13:00:00-07:00', timeZone: LA }, end: { dateTime: '2026-10-26T14:00:00-07:00', timeZone: LA } }, zone: LA, requestId: 'r' }));
    expect(plan.map((op) => [op.method, op.eventId, op.role])).toEqual([['POST', null, 'create'], ['PATCH', 'wk', 'truncate']]);
    expect(plan[0]!.body).toMatchObject({
      summary: 'New sync',
      description: 'Agenda',
      start: { dateTime: '2026-10-26T13:00:00-07:00', timeZone: LA },
      end: { dateTime: '2026-10-26T14:00:00-07:00', timeZone: LA },
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
    });
    // Guests come along without the answers they gave the old series.
    expect((plan[0]!.body!.attendees as unknown[])[1]).toEqual({ email: 'ann@x.com', displayName: 'Ann' });
    expect(plan[1]!.body).toEqual({ recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261026T155959Z'] });
  });

  test('This and following on a counted series needs how many came before; on the first event it is All events', () => {
    const counted = { ...series, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10', 'EXDATE;TZID=America/Los_Angeles:20261012T090000'] };
    expect(planEdit({ scope: 'following', instance: occurrence('2026-10-26'), series: counted, input: { summary: 'x' }, zone: LA, requestId: 'r' })).toMatchObject({ needs: 'priorCount' });
    const plan = ops(planEdit({ scope: 'following', instance: occurrence('2026-10-26'), series: counted, input: { summary: 'x' }, zone: LA, requestId: 'r', priorCount: 3 }));
    expect(plan[0]!.body!.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=7', 'EXDATE;TZID=America/Los_Angeles:20261012T090000']);
    expect(plan[1]!.body).toEqual({ recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261026T155959Z', 'EXDATE;TZID=America/Los_Angeles:20261012T090000'] });
    expect(planEdit({ scope: 'following', instance: occurrence('2026-10-26'), series: counted, input: { summary: 'x' }, zone: LA, requestId: 'r', priorCount: 10 })).toMatchObject({ error: expect.stringContaining('no events') });
    expect(ops(planEdit({ scope: 'following', instance: occurrence('2026-10-05'), series, input: { summary: 'x' }, zone: LA, requestId: 'r' }))).toEqual([{ method: 'PATCH', eventId: 'wk', body: { summary: 'x' }, conference: false, role: 'change' }]);
  });

  test('a new repeat rule from here on, and a rule the Planner cannot move', () => {
    const plan = ops(planEdit({ scope: 'following', instance: occurrence('2026-10-26'), series, input: { recurrence: ['RRULE:FREQ=DAILY'] }, zone: LA, requestId: 'r' }));
    expect(plan[0]!.body!.recurrence).toEqual(['RRULE:FREQ=DAILY']);
    const odd = { ...series, recurrence: ['RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=4'] };
    expect(planEdit({ scope: 'all', instance: occurrence('2026-10-26'), series: odd, input: { start: { dateTime: '2026-10-27T09:00:00-07:00' }, end: { dateTime: '2026-10-27T10:00:00-07:00' } }, zone: LA, requestId: 'r' })).toMatchObject({ error: expect.stringContaining('cannot move') });
    expect(planEdit({ scope: 'all', instance: occurrence('2026-10-26'), series: null, input: {}, zone: LA, requestId: 'r' })).toMatchObject({ error: expect.stringContaining('gone') });
  });
});

describe('deleting and answering', () => {
  test('delete this event, this and following, all events', () => {
    const instance = occurrence('2026-10-26');
    expect(ops(planDelete({ scope: 'this', instance, series }))).toEqual([{ method: 'DELETE', eventId: instance.id, role: 'delete' }]);
    expect(ops(planDelete({ scope: 'all', instance, series }))).toEqual([{ method: 'DELETE', eventId: 'wk', role: 'delete' }]);
    expect(ops(planDelete({ scope: 'following', instance, series }))).toEqual([{ method: 'PATCH', eventId: 'wk', body: { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261026T155959Z'] }, role: 'truncate' }]);
    expect(ops(planDelete({ scope: 'following', instance: occurrence('2026-10-05'), series }))).toEqual([{ method: 'DELETE', eventId: 'wk', role: 'delete' }]);
    expect(ops(planDelete({ scope: 'all', instance: { id: 'one' }, series: null }))).toEqual([{ method: 'DELETE', eventId: 'one', role: 'delete' }]);
  });
  test('an answer changes only my own entry, on the occurrence or the series', () => {
    const invited = [{ email: 'ann@x.com', organizer: true, responseStatus: 'accepted' }, { email: 'me@x.com', self: true, responseStatus: 'needsAction' }];
    const instance = { ...occurrence('2026-10-26'), attendees: invited };
    const [op] = ops(planRsvp({ scope: 'this', instance, series: { ...series, attendees: invited }, response: 'tentative' }));
    expect(op).toEqual({ method: 'PATCH', eventId: instance.id, body: { attendees: [invited[0], { ...invited[1], responseStatus: 'tentative' }] }, role: 'change' });
    expect(ops(planRsvp({ scope: 'all', instance, series: { ...series, attendees: invited }, response: 'accepted' }))[0]!.eventId).toBe('wk');
    expect(planRsvp({ scope: 'this', instance: { ...instance, attendees: [invited[0]!] }, series, response: 'accepted' })).toMatchObject({ error: expect.stringContaining('guest list') });
  });
});

describe('what the details show', () => {
  test('an occurrence with its series’ rule, guests and their answers, the call and reminders', () => {
    const detail = eventDetail(
      { ...occurrence('2026-10-26'), attendees: [{ email: 'ann@x.com', organizer: true, responseStatus: 'accepted', displayName: 'Ann Lee' }, { email: 'me@x.com', self: true, responseStatus: 'tentative' }], organizer: { email: 'ann@x.com', displayName: 'Ann Lee' }, conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }], conferenceSolution: { name: 'Google Meet' } }, reminders: { useDefault: true } },
      { account: 'me@x.com', calendarId: 'primary', accessRole: 'owner' },
      ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
    );
    expect(detail).toMatchObject({
      recurringEventId: 'wk',
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
      editable: false,
      response: 'tentative',
      organizer: { email: 'ann@x.com', name: 'Ann Lee', self: false },
      meet: { url: 'https://meet.google.com/abc-defg-hij', label: 'Google Meet' },
      reminders: { useDefault: true, overrides: [] },
      allDay: false,
    });
    expect(detail.attendees.map((guest) => [guest.name, guest.response, guest.organizer])).toEqual([['Ann Lee', 'accepted', true], ['me@x.com', 'tentative', false]]);
  });
  test('descriptions written in Google Calendar are HTML: shown as plain text', () => {
    expect(descriptionText('Plain &amp; simple')).toBe('Plain & simple');
    expect(descriptionText('<b>Agenda</b><br>1. Plan<br/>2. Do<ul><li>one</li><li>two</li></ul><a href="https://example.com/doc">the doc</a>&nbsp;<script>x</script>')).toBe('Agenda\n1. Plan\n2. Do\n• one\n• two\n\nthe doc (https://example.com/doc) x');
  });
});
