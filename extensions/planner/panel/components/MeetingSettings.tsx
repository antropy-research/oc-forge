// Settings → Meeting import, as Sunsama's (Settings → Calendar → Meeting import, help.sunsama.com/docs/usage-guides/
// importing-meetings): how meetings get added to the daily task list (a prompt in daily planning, or auto-sync ahead
// of time), the calendars to import from, the kinds of events excluded, auto-completion when an event ends, and an
// import channel per calendar. A change applies at once: meetings it adds or removes are added or removed.
import { MEETING_EXCLUSIONS, type MeetingExclusion, type Settings as PlannerSettings } from '../../src/domain/types.ts';
import { MEETING_EXCLUSION_LABELS } from '../../src/domain/meetings.ts';
import { liveChannels } from '../../src/domain/selectors.ts';
import { useGoogle, usePlanner, useView } from '../lib/context.ts';

export const MeetingSettings = () => {
  const { client, google } = usePlanner();
  const view = useView();
  const gv = useGoogle();
  const settings = view.state.settings;
  const calendars = Object.values(view.state.calendars).filter((calendar) => calendar.google).sort((a, b) => a.name.localeCompare(b.name));
  if (!gv.status || !google.accountsWith('calendar').length || !calendars.length) return null;
  const channels = liveChannels(view.state);
  // A setting that adds or removes meetings applies at once, as Sunsama's does.
  const update = (patch: Partial<PlannerSettings>) =>
    void client.dispatch([{ type: 'settings.updated', patch }]).then(() => client.call('POST', '/meetings/sync').catch((error) => client.notify(`Meeting import: ${error instanceof Error ? error.message : String(error)}`)));
  const chosen = new Set(settings.meetingCalendars);
  const exclusions = new Set(settings.meetingExclusions);
  const toggleCalendar = (id: string) => update({ meetingCalendars: chosen.has(id) ? settings.meetingCalendars.filter((item) => item !== id) : [...settings.meetingCalendars, id] });
  const toggleExclusion = (kind: MeetingExclusion) => update({ meetingExclusions: exclusions.has(kind) ? settings.meetingExclusions.filter((item) => item !== kind) : [...settings.meetingExclusions, kind] });
  return (
    <fieldset>
      <legend>Meeting import</legend>
      <p class="hint">
        As in Sunsama: meetings on your calendar become tasks, for a clear view of the day's workload and its time in your stats; checking one off counts it as done.
        A single event is added from its details (Add to tasks), whatever is set here; Remove from tasks takes one off the list without touching the calendar.
      </p>
      <label>
        Configure how meetings get added to your daily task list
        <select value={settings.meetingImport} onChange={(event) => update({ meetingImport: event.currentTarget.value as PlannerSettings['meetingImport'] })}>
          <option value="prompt">Show prompt (review and confirm suggested events during daily planning)</option>
          <option value="autoSync">Auto-sync (add the appropriate events to your task list by themselves)</option>
        </select>
      </label>
      <div class="meeting-calendars" role="group" aria-label="Calendars to import from">
        <h3>Calendars to import from</h3>
        <p class="hint">{settings.meetingImport === 'autoSync' ? 'Auto-sync imports from these alone.' : 'None chosen: the calendars shown are suggested from.'}</p>
        {settings.meetingImport === 'autoSync' && chosen.size === 0 && <p class="danger" role="alert">You must select Calendars to import from: auto-sync imports nothing until one is.</p>}
        {calendars.map((calendar) => (
          <div key={calendar.id} class="row meeting-calendar">
            <label class="grow">
              <input type="checkbox" checked={chosen.has(calendar.id)} onChange={() => toggleCalendar(calendar.id)} />
              <span class="dot" style={{ background: calendar.color }} aria-hidden="true" /> {calendar.name} <span class="muted">{calendar.google!.account}</span>
            </label>
            {chosen.has(calendar.id) && channels.length > 0 && (
              <select aria-label={`Import channel for ${calendar.name}`} value={settings.meetingChannels[calendar.id] ?? ''} onChange={(event) => {
                const channels = { ...settings.meetingChannels };
                if (event.currentTarget.value) channels[calendar.id] = event.currentTarget.value;
                else delete channels[calendar.id];
                update({ meetingChannels: channels });
              }}>
                <option value="">No import channel</option>
                {channels.map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
              </select>
            )}
          </div>
        ))}
      </div>
      <div class="meeting-exclusions" role="group" aria-label="Exclude certain types of events">
        <h3>Exclude certain types of events</h3>
        <p class="hint">With Auto-sync, excluded events are not imported; with Show prompt, they are not selected to start with.</p>
        {MEETING_EXCLUSIONS.map((kind) => (
          <label key={kind}>
            <input type="checkbox" checked={exclusions.has(kind)} onChange={() => toggleExclusion(kind)} /> {MEETING_EXCLUSION_LABELS[kind]}
          </label>
        ))}
      </div>
      <label>
        Auto-complete imported calendar events
        <select value={settings.meetingAutoComplete} onChange={(event) => update({ meetingAutoComplete: event.currentTarget.value as PlannerSettings['meetingAutoComplete'] })}>
          <option value="always">Always (when the event's end time passes)</option>
          <option value="never">Never</option>
          <option value="invitees">Only if the event has invitees</option>
        </select>
      </label>
      <p class="hint">An event whose timer is running is not completed until the timer stops.</p>
    </fieldset>
  );
};
