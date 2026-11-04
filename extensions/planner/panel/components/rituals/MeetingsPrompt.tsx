// Daily planning's "fill in calendar events", as Sunsama's first planning step has it (help.sunsama.com/docs/
// usage-guides/importing-meetings): the day's meetings from the calendars to import from, the suggested ones ticked
// (the excluded kinds not, each saying why); one button imports them, in time order, and "Pick events" chooses.
// With auto-sync they are on the list already.
import { useState } from 'preact/hooks';
import type { DateKey } from '../../../src/domain/types.ts';
import { clockLabel, zonedDateMinutes } from '../../../src/domain/dates.ts';
import { MEETING_EXCLUSION_LABELS, addMeetingsCommands, meetingSuggestions, type MeetingSuggestion } from '../../../src/domain/meetings.ts';
import { newId } from '../../../src/domain/ids.ts';
import { usePlanner, useView } from '../../lib/context.ts';
import { useCalendarEvents } from '../../lib/calendar.ts';

const why = (suggestion: MeetingSuggestion): string =>
  suggestion.excluded === 'declined' ? 'declined' : suggestion.excluded ? MEETING_EXCLUSION_LABELS[suggestion.excluded].replace(/^Exclude /, '') : '';

export const MeetingsPrompt = ({ date }: { date: DateKey }) => {
  const { client } = usePlanner();
  const view = useView();
  const feed = useCalendarEvents(date, date);
  const zone = view.state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const suggestions = meetingSuggestions(view.state, feed.events, date, zone);
  // In the plan already: done; one removed from it can be imported again by hand.
  const open = suggestions.filter((suggestion) => !suggestion.task || suggestion.task.deletedAt);
  const chosen = picked ?? new Set(open.filter((suggestion) => !suggestion.excluded).map((suggestion) => suggestion.key));
  if (view.state.settings.meetingImport === 'autoSync') {
    const added = suggestions.filter((suggestion) => suggestion.task && !suggestion.task.deletedAt).length;
    return <p class="hint meetings-prompt" role="note">Meetings are added by themselves (Settings → Meeting import): {added} on this day.</p>;
  }
  if (!open.length) return null;
  const importChosen = () => {
    const events = open.filter((suggestion) => chosen.has(suggestion.key)).map((suggestion) => suggestion.event);
    const bodies = addMeetingsCommands(view.state, events, zone, newId);
    if (!bodies.length) return;
    void client.dispatch(bodies, { undo: `${events.length} event${events.length === 1 ? '' : 's'} added to tasks` });
    setPicked(null);
    setPicking(false);
  };
  const toggle = (key: string) =>
    setPicked(() => {
      const next = new Set(chosen);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  return (
    <div class="meetings-prompt" role="region" aria-label="Fill in calendar events">
      <div class="row">
        <strong class="grow">Fill in calendar events</strong>
        <button class="primary" disabled={!chosen.size} onClick={importChosen}>Import {chosen.size} event{chosen.size === 1 ? '' : 's'}</button>
        <button class="link" aria-expanded={picking} onClick={() => setPicking((open) => !open)}>Pick events</button>
      </div>
      {picking && (
        <ul class="meetings-pick">
          {open.map((suggestion) => (
            <li key={suggestion.key}>
              <label>
                <input type="checkbox" checked={chosen.has(suggestion.key)} onChange={() => toggle(suggestion.key)} />
                <span class="muted">{suggestion.event.allDay ? 'All day' : clockLabel(zonedDateMinutes(suggestion.event.start, zone).minutes)}</span> {suggestion.event.title}
                {suggestion.excluded && <span class="muted"> · {why(suggestion)}</span>}
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
