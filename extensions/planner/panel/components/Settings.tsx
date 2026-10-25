import { useEffect, useState } from 'preact/hooks';
import { CHANNEL_COLORS, type Settings as PlannerSettings } from '../../src/domain/types.ts';
import { liveChannels } from '../../src/domain/selectors.ts';
import { newId } from '../../src/domain/ids.ts';
import { useGoogle, useLinear, usePlanner, useView } from '../lib/context.ts';
import type { GoogleFeature } from '../lib/google.ts';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
      <p class="hint">Meetings show on the calendar and auto-scheduling works around them. Connect Google Calendar under Google below, or subscribe to a read-only ICS feed here.</p>
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

/** OpenChamber's own Linear connection, plus workspaces added with a personal API key. */
const LinearWorkspaceList = () => {
  const { client, linear } = usePlanner();
  const lv = useLinear();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const hostWorkspace = lv.workspaces.find((workspace) => workspace.via === 'host');
  const keyed = lv.workspaces.filter((workspace) => workspace.via === 'key');
  const add = () => {
    if (!key.trim() || busy) return;
    setBusy(true);
    setProblem(null);
    linear
      .addWorkspace(key)
      .then((workspace) => {
        setKey('');
        client.notify(`Added the Linear workspace ${workspace.name}`);
      })
      .catch((error) => setProblem(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <ul class="channel-list workspace-list" aria-label="Linear workspaces">
        <li>
          <span class="channel-name">{hostWorkspace ? hostWorkspace.name : 'OpenChamber connection'}</span>
          <span class="muted grow">
            {hostWorkspace ? `through OpenChamber, as ${hostWorkspace.account}` : lv.connected === false ? 'not connected' : lv.connected ? `connected${lv.account ? ` as ${lv.account}` : ''}` : 'checking…'}
          </span>
          {lv.connected === false && <button class="link" onClick={() => void linear.connect()}>Connect Linear</button>}
        </li>
        {keyed.map((workspace) => (
          <li key={workspace.id}>
            <span class="channel-name">{workspace.name}</span>
            <span class={`grow ${workspace.error ? 'danger' : 'muted'}`}>API key, as {workspace.account}{workspace.error ? ` · ${workspace.error}` : ''}</span>
            <button class="link danger" aria-label={`Remove the Linear workspace ${workspace.name}`} onClick={() => void linear.removeWorkspace(workspace.id).catch((error) => setProblem(error instanceof Error ? error.message : String(error)))}>Remove</button>
          </li>
        ))}
      </ul>
      <p class="hint">
        OpenChamber connects one Linear workspace. Add more with a personal API key from Linear → Settings → Security &amp; access. Keys stay on this machine, outside the synced
        plan, in a file only you can read, and run nothing but the Planner's own Linear requests.
      </p>
      <div class="row">
        <input class="grow" type="password" autocomplete="off" aria-label="Linear API key" placeholder="lin_api_…" value={key} onInput={(event) => setKey(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && add()} />
        <button onClick={add} disabled={busy || !key.trim()}>{busy ? 'Checking…' : 'Add workspace'}</button>
      </div>
      {problem && <p class="danger" role="alert">{problem}</p>}
    </>
  );
};

const LinearSettings = () => {
  const { client } = usePlanner();
  const view = useView();
  const { settings } = view.state;
  const update = (patch: Partial<PlannerSettings>) => void client.dispatch([{ type: 'settings.updated', patch }]);
  return (
    <fieldset>
      <legend>Linear</legend>
      <LinearWorkspaceList />
      <label>
        When I complete a Linear task
        <select value={settings.linearOnComplete} onChange={(event) => update({ linearOnComplete: event.currentTarget.value as PlannerSettings['linearOnComplete'] })}>
          <option value="ask">Ask me</option>
          <option value="complete">Move the issue to Done</option>
          <option value="nothing">Leave Linear alone</option>
        </select>
      </label>
      <label>
        When I plan a Linear issue for a day
        <select value={settings.linearOnPlan} onChange={(event) => update({ linearOnPlan: event.currentTarget.value as PlannerSettings['linearOnPlan'] })}>
          <option value="nothing">Leave Linear alone</option>
          <option value="ask">Ask me</option>
          <option value="start">Move it to In Progress</option>
        </select>
      </label>
      <label>
        Complete a task when its issue is closed in Linear
        <input type="checkbox" checked={settings.linearImportCompletion} onChange={(event) => update({ linearImportCompletion: event.currentTarget.checked })} />
      </label>
    </fieldset>
  );
};

const FEATURE_LABELS: Record<GoogleFeature, string> = { calendar: 'Calendar', tasks: 'Tasks', mail: 'Gmail' };

/** Signing in an account: Google's page opens; its redirect comes back here, or its address is pasted. */
const GoogleSignIn = () => {
  const { google, host, client } = usePlanner();
  const gv = useGoogle();
  const [features, setFeatures] = useState<GoogleFeature[]>(['calendar', 'tasks', 'mail']);
  const [pasted, setPasted] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const signIn = gv.signIn;
  if (!signIn || signIn.result.status === 'connected') {
    return (
      <div class="google-connect">
        <div class="row" role="group" aria-label="What the Planner may use">
          {(['calendar', 'tasks', 'mail'] as const).map((feature) => (
            <label key={feature} class="inline">
              <input type="checkbox" checked={features.includes(feature)} onChange={(event) => setFeatures(event.currentTarget.checked ? [...features, feature] : features.filter((item) => item !== feature))} />
              {FEATURE_LABELS[feature]}
            </label>
          ))}
          <div class="nav-spacer" />
          <button disabled={!features.length} onClick={() => { setProblem(null); google.connect(features).catch((error) => setProblem(messageOf(error))); }}>Connect a Google account</button>
        </div>
        <p class="hint">Calendar reads your calendars and writes working sessions to the one you choose; Tasks reads and updates Google Tasks; Gmail only reads messages.</p>
        {problem && <p class="danger" role="alert">{problem}</p>}
      </div>
    );
  }
  if (signIn.result.status === 'failed') {
    return (
      <div class="google-connect">
        <p class="danger" role="alert">Not connected: {signIn.result.message}</p>
        <button class="link" onClick={() => google.cancelSignIn()}>Try again</button>
      </div>
    );
  }
  const finish = () => {
    setProblem(null);
    google.finishSignIn(pasted).then(() => setPasted('')).catch((error) => setProblem(messageOf(error)));
  };
  return (
    <div class="google-connect" aria-live="polite">
      <p>
        Waiting for Google… <button class="link" onClick={() => void host.openUrl(signIn.authUrl)}>Open Google's sign-in page</button> ·{' '}
        <button class="link" onClick={() => void host.writeClipboard(signIn.authUrl).then(() => client.notify('Copied the sign-in address'))}>Copy its address</button> ·{' '}
        <button class="link" onClick={() => google.cancelSignIn()}>Cancel</button>
      </p>
      <p class="hint">
        After you allow access, Google sends the browser to <code>{signIn.redirectUri}</code>. On this machine the Planner picks that up by itself. If the browser runs elsewhere, that page
        won't load: copy its whole address from the address bar and paste it here.
      </p>
      <div class="row">
        <input class="grow" aria-label="Address Google sent the browser to" placeholder={`${signIn.redirectUri}?state=…&code=…`} value={pasted} onInput={(event) => setPasted(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && pasted.trim() && finish()} />
        <button disabled={!pasted.trim()} onClick={finish}>Finish</button>
      </div>
      {problem && <p class="danger" role="alert">{problem}</p>}
    </div>
  );
};

/** Which Google calendars show beside the plan, and where working sessions are written. */
const GoogleCalendarChoices = () => {
  const { google } = usePlanner();
  const view = useView();
  const gv = useGoogle();
  const target = view.state.settings.googleTimebox;
  const shown = (account: string, id: string) => Object.values(view.state.calendars).some((calendar) => calendar.google?.account === account && calendar.google.calendarId === id && calendar.visible);
  const several = new Set(gv.calendars.map((calendar) => calendar.account)).size > 1;
  const writable = gv.calendars.filter((calendar) => calendar.writable);
  const selected = target ? writable.findIndex((calendar) => calendar.account === target.account && calendar.id === target.calendarId) : -1;
  return (
    <div class="google-calendars">
      <h4>Google calendars to show</h4>
      {gv.calendarErrors.map((error) => <p key={error.account} class="danger">{error.account ? `${error.account}: ` : ''}{error.message}</p>)}
      <ul class="channel-list" aria-label="Google calendars">
        {gv.calendars.map((calendar) => (
          <li key={`${calendar.account}:${calendar.id}`}>
            <span class="calendar-swatch" style={{ background: calendar.color }} aria-hidden="true" />
            <label class="inline grow">
              <input type="checkbox" checked={shown(calendar.account, calendar.id)} onChange={(event) => void google.showCalendar(calendar, event.currentTarget.checked)} />
              {calendar.name}
              {calendar.primary ? ' (primary)' : ''}
              {several ? <span class="muted"> · {calendar.account}</span> : null}
            </label>
          </li>
        ))}
        {gv.calendars.length === 0 && !gv.calendarErrors.length && <li class="muted">Loading calendars…</li>}
      </ul>
      <label>
        Write working sessions to
        <select
          aria-label="Google calendar for working sessions"
          value={selected >= 0 ? String(selected) : target ? 'current' : ''}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === 'current') return;
            const calendar = writable[Number(value)];
            void google.setTimeboxCalendar(value === '' || !calendar ? null : { account: calendar.account, calendarId: calendar.id });
          }}
        >
          <option value="">Don't write them</option>
          {target && selected < 0 && <option value="current">{target.calendarId} · {target.account}</option>}
          {writable.map((calendar, index) => <option key={`${calendar.account}:${calendar.id}`} value={String(index)}>{several ? `${calendar.name} · ${calendar.account}` : calendar.name}</option>)}
        </select>
      </label>
      <p class="hint">Each timeboxed session becomes an event there, and moves or goes with it; move or delete that event in Google Calendar and the session follows.</p>
      {gv.status?.timeboxError && <p class="danger" role="alert">The last session could not be written: {gv.status.timeboxError}</p>}
    </div>
  );
};

const GoogleSettings = () => {
  const { client, google } = usePlanner();
  const view = useView();
  const gv = useGoogle();
  const { settings } = view.state;
  const update = (patch: Partial<PlannerSettings>) => void client.dispatch([{ type: 'settings.updated', patch }]);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const status = gv.status;
  const calendarAccounts = status ? google.accountsWith('calendar').length : 0;
  useEffect(() => {
    if (calendarAccounts) void google.loadCalendars();
  }, [calendarAccounts]);
  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    work()
      .catch((error) => setProblem(messageOf(error)))
      .finally(() => setBusy(false));
  };
  return (
    <fieldset>
      <legend>Google</legend>
      {!status && <p class="hint">Checking…</p>}
      {status && !status.client && (
        <>
          <p class="hint">
            Google Calendar, Google Tasks and Gmail connect through an OAuth client in your own Google Cloud project: create a project, enable the Google Calendar API, Google Tasks API
            and Gmail API, set up the OAuth consent screen with yourself as a test user, then create an OAuth client ID of type <strong>Desktop app</strong> and paste its ID and secret
            here. They stay on this machine, outside the synced plan, in a file only you can read.
          </p>
          <div class="row">
            <input class="grow" autocomplete="off" aria-label="Google OAuth client ID" placeholder="1234…-abc….apps.googleusercontent.com" value={clientId} onInput={(event) => setClientId(event.currentTarget.value)} />
          </div>
          <div class="row">
            <input class="grow" type="password" autocomplete="off" aria-label="Google OAuth client secret" placeholder="GOCSPX-…" value={secret} onInput={(event) => setSecret(event.currentTarget.value)} />
            <button disabled={busy || !clientId.trim() || !secret.trim()} onClick={() => run(() => google.setClient(clientId, secret).then(() => { setClientId(''); setSecret(''); }))}>Save</button>
          </div>
        </>
      )}
      {status?.client && (
        <>
          <ul class="channel-list workspace-list" aria-label="Google accounts">
            {status.accounts.map((account) => (
              <li key={account.email}>
                <span class="channel-name">{account.email}</span>
                <span class="muted grow">{account.features.map((feature) => FEATURE_LABELS[feature]).join(', ') || 'nothing allowed'}</span>
                <button class="link danger" aria-label={`Remove the Google account ${account.email}`} onClick={() => run(() => google.removeAccount(account.email))}>Remove</button>
              </li>
            ))}
            {status.accounts.length === 0 && <li class="muted">No account connected yet.</li>}
          </ul>
          <GoogleSignIn />
          <p class="hint">
            OAuth client <code>{status.client.id.split('-')[0]}…</code> · <button class="link danger" disabled={busy} onClick={() => run(() => google.clearClient())}>Remove the client and its accounts</button>
          </p>
        </>
      )}
      {problem && <p class="danger" role="alert">{problem}</p>}
      {status && calendarAccounts > 0 && <GoogleCalendarChoices />}
      {status && google.accountsWith('tasks').length > 0 && (
        <>
          <label>
            When I complete a Google task
            <select value={settings.googleTasksOnComplete} onChange={(event) => update({ googleTasksOnComplete: event.currentTarget.value as PlannerSettings['googleTasksOnComplete'] })}>
              <option value="complete">Complete it in Google Tasks</option>
              <option value="ask">Ask me</option>
              <option value="nothing">Leave Google Tasks alone</option>
            </select>
          </label>
          <label>
            Complete a task when it is completed in Google Tasks
            <input type="checkbox" checked={settings.googleTasksImportCompletion} onChange={(event) => update({ googleTasksImportCompletion: event.currentTarget.checked })} />
          </label>
          <label>
            Planning a Google task on a day makes it due that day (Google Calendar shows it there)
            <input type="checkbox" checked={settings.googleTasksDueFromPlan} onChange={(event) => update({ googleTasksDueFromPlan: event.currentTarget.checked })} />
          </label>
        </>
      )}
    </fieldset>
  );
};

const SyncSettings = () => {
  const { client } = usePlanner();
  const view = useView();
  const sync = view.sync;
  const [remote, setRemote] = useState(sync?.remote ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const save = () => {
    setProblem(null);
    client.setRemote(remote.trim() || null).catch((error) => setProblem(error instanceof Error ? error.message : String(error)));
  };
  return (
    <fieldset>
      <legend>Sync</legend>
      <p class="hint">
        Keep the planner's data repository in step with a git remote, for example a private GitHub repository. Each change is one line in an event file and lines merge on
        their own, so several machines can share one plan. The service uses this machine's git credentials (SSH keys or a credential helper).
      </p>
      <div class="row">
        <input class="grow" aria-label="Sync remote" placeholder="git@github.com:you/planner-data.git" value={remote} onInput={(event) => setRemote(event.currentTarget.value)} onKeyDown={(event) => event.key === 'Enter' && save()} />
        <button onClick={save}>{remote.trim() ? 'Save' : 'Remove'}</button>
      </div>
      {problem && <p class="danger">{problem}</p>}
      {sync?.remote && (
        <div class="row sync-row">
          <button onClick={() => void client.syncNow().catch((error) => setProblem(error instanceof Error ? error.message : String(error)))} disabled={sync.syncing}>{sync.syncing ? 'Syncing…' : 'Sync now'}</button>
          <span class="muted" aria-live="polite">{sync.lastSyncAt ? `Last synced ${new Date(sync.lastSyncAt).toLocaleString()}` : 'Not synced yet'}</span>
        </div>
      )}
      {sync?.lastError && <p class="danger" role="alert">Sync failed: {sync.lastError}</p>}
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
            Suggest time and channel from similar tasks
            <input type="checkbox" checked={settings.suggestFromHistory} onChange={(event) => update({ suggestFromHistory: event.currentTarget.checked })} />
          </label>
          <label>
            Pomodoro focus / break (minutes)
            <span class="row">
              <input type="number" min="1" max="180" aria-label="Pomodoro focus minutes" value={settings.pomodoroMinutes} onChange={(event) => { const value = Number(event.currentTarget.value); if (Number.isInteger(value) && value >= 1 && value <= 180) update({ pomodoroMinutes: value }); }} />
              <input type="number" min="1" max="180" aria-label="Pomodoro break minutes" value={settings.breakMinutes} onChange={(event) => { const value = Number(event.currentTarget.value); if (Number.isInteger(value) && value >= 1 && value <= 180) update({ breakMinutes: value }); }} />
            </span>
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
        <GoogleSettings />
        <LinearSettings />
        <SyncSettings />
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
