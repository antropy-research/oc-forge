import { useState } from 'preact/hooks';
import { CHANNEL_COLORS, type Settings as PlannerSettings } from '../../src/domain/types.ts';
import { liveChannels } from '../../src/domain/selectors.ts';
import { newId } from '../../src/domain/ids.ts';
import { usePlanner, useView } from '../lib/context.ts';

const zones = (current: string | null): string[] => {
  const all = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  return current && !all.includes(current) ? [current, ...all] : all;
};

const Channels = () => {
  const { client } = usePlanner();
  const view = useView();
  const [name, setName] = useState('');
  const channels = liveChannels(view.state);
  const add = () => {
    const trimmed = name.trim();
    if (!/^[\p{L}\p{N}_-]{1,40}$/u.test(trimmed)) return;
    void client.dispatch([{ type: 'channel.created', channel: { id: newId(), name: trimmed, color: CHANNEL_COLORS[channels.length % CHANNEL_COLORS.length]!, context: 'work' } }]);
    setName('');
  };
  return (
    <fieldset>
      <legend>Channels</legend>
      <p class="hint">Personal-context channels stay out of the workload total, as in Sunsama.</p>
      <ul class="channel-list">
        {channels.map((channel) => (
          <li key={channel.id}>
            <input
              type="color"
              value={channel.color}
              aria-label={`${channel.name} color`}
              onChange={(event) => void client.dispatch([{ type: 'channel.updated', channelId: channel.id, patch: { color: event.currentTarget.value } }])}
            />
            <span class="channel-name">#{channel.name}</span>
            <select
              value={channel.context}
              aria-label={`${channel.name} context`}
              onChange={(event) => void client.dispatch([{ type: 'channel.updated', channelId: channel.id, patch: { context: event.currentTarget.value as 'work' | 'personal' } }])}
            >
              <option value="work">Work</option>
              <option value="personal">Personal</option>
            </select>
            <button class="link danger" onClick={() => void client.dispatch([{ type: 'channel.deleted', channelId: channel.id }])}>Delete</button>
          </li>
        ))}
      </ul>
      <div class="row">
        <input value={name} placeholder="New channel" aria-label="New channel name" onInput={(event) => setName(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && add()} />
        <button onClick={add}>Add</button>
      </div>
    </fieldset>
  );
};

const hhmm = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const fromHhmm = (value: string): number | null => {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

const Calendars = () => {
  const { client } = usePlanner();
  const view = useView();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const calendars = Object.values(view.state.calendars);
  const add = () => {
    if (!name.trim() || !/^(https?|webcal|file):\/\//i.test(url.trim())) return;
    void client.dispatch([{ type: 'calendar.added', calendar: { id: newId(), name: name.trim(), url: url.trim(), color: CHANNEL_COLORS[(calendars.length + 3) % CHANNEL_COLORS.length]! } }]);
    setName('');
    setUrl('');
  };
  return (
    <fieldset>
      <legend>Calendars</legend>
      <p class="hint">Subscribe to read-only ICS feeds (for Google Calendar, use "Secret address in iCal format"). Meetings show on the calendar and auto-scheduling works around them.</p>
      <ul class="channel-list">
        {calendars.map((calendar) => (
          <li key={calendar.id}>
            <input type="color" value={calendar.color} aria-label={`${calendar.name} color`} onChange={(event) => void client.dispatch([{ type: 'calendar.updated', calendarId: calendar.id, patch: { color: event.currentTarget.value } }])} />
            <span class="channel-name" title={calendar.url}>{calendar.name}</span>
            <label class="inline">
              <input type="checkbox" checked={calendar.visible} onChange={(event) => void client.dispatch([{ type: 'calendar.updated', calendarId: calendar.id, patch: { visible: event.currentTarget.checked } }])} />
              Show
            </label>
            <button class="link danger" onClick={() => void client.dispatch([{ type: 'calendar.removed', calendarId: calendar.id }])}>Remove</button>
          </li>
        ))}
      </ul>
      <div class="row">
        <input value={name} placeholder="Name" aria-label="Calendar name" onInput={(event) => setName(event.currentTarget.value)} />
        <input class="grow" value={url} placeholder="https://…/basic.ics" aria-label="Calendar URL" onInput={(event) => setUrl(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && add()} />
        <button onClick={add}>Subscribe</button>
      </div>
    </fieldset>
  );
};

export const Settings = () => {
  const { client } = usePlanner();
  const view = useView();
  const { settings } = view.state;
  const update = (patch: Partial<PlannerSettings>) => void client.dispatch([{ type: 'settings.updated', patch }]);
  return (
    <section class="view">
      <header class="view-header">
        <h1>Settings</h1>
      </header>
      <div class="view-scroll settings">
        <fieldset>
          <legend>Day</legend>
          <label>
            Timezone
            <select value={settings.timezone ?? ''} onChange={(event) => update({ timezone: event.currentTarget.value })}>
              {zones(settings.timezone).map((zone) => <option key={zone} value={zone}>{zone}</option>)}
            </select>
          </label>
          <label>
            Workload threshold (hours)
            <input
              type="number"
              min="0.5"
              max="24"
              step="0.5"
              value={settings.workloadMinutes / 60}
              onChange={(event) => {
                const hours = Number(event.currentTarget.value);
                if (hours > 0 && hours <= 24) update({ workloadMinutes: Math.round(hours * 60) });
              }}
            />
          </label>
          <label>
            Archive after consecutive rollovers
            <input
              type="number"
              min="1"
              max="365"
              placeholder="Never"
              value={settings.archiveAfterRollovers ?? ''}
              onChange={(event) => {
                const raw = event.currentTarget.value.trim();
                const days = Number(raw);
                if (!raw) update({ archiveAfterRollovers: null });
                else if (Number.isInteger(days) && days >= 1 && days <= 365) update({ archiveAfterRollovers: days });
              }}
            />
          </label>
          <label>
            Working hours
            <span class="row">
              <input type="time" aria-label="Workday start" value={hhmm(settings.workdayStart)} onChange={(event) => { const value = fromHhmm(event.currentTarget.value); if (value !== null && value < settings.workdayEnd) update({ workdayStart: value }); }} />
              <span>–</span>
              <input type="time" aria-label="Workday end" value={hhmm(settings.workdayEnd)} onChange={(event) => { const value = fromHhmm(event.currentTarget.value); if (value !== null && value > settings.workdayStart) update({ workdayEnd: value }); }} />
            </span>
          </label>
          <label>
            Count planned time as actual
            <input type="checkbox" checked={settings.plannedAsActual} onChange={(event) => update({ plannedAsActual: event.currentTarget.checked })} />
          </label>
          <label>
            Week starts on
            <select value={String(settings.weekStartsOn)} onChange={(event) => update({ weekStartsOn: event.currentTarget.value === '0' ? 0 : 1 })}>
              <option value="1">Monday</option>
              <option value="0">Sunday</option>
            </select>
          </label>
        </fieldset>
        <Channels />
        <Calendars />
        <fieldset>
          <legend>Storage</legend>
          {view.storage ? (
            <dl class="facts">
              <dt>Data folder</dt><dd><code>{view.storage.dir}</code></dd>
              <dt>History</dt><dd>{view.storage.git ? `git, last commit ${view.storage.lastCommitAt ? new Date(view.storage.lastCommitAt).toLocaleString() : 'pending'}` : 'git unavailable; events are kept without history'}</dd>
              {view.storage.lastError && (<><dt>Last error</dt><dd class="danger">{view.storage.lastError}</dd></>)}
              {view.storage.skippedLines > 0 && (<><dt>Unreadable lines</dt><dd>{view.storage.skippedLines}</dd></>)}
            </dl>
          ) : <p>Loading…</p>}
        </fieldset>
      </div>
    </section>
  );
};
