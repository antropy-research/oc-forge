// Every object the service is made of, built over the plan's data folder: the plan (its event store, the planner and
// git sync), calendar feeds and the meeting import, GitHub, Linear workspaces, Google (the accounts, their data, and
// what is kept in step with them) and OpenCode's agents. Each route gets them as its context. Files kept beside the
// data folder stay on this machine, never in its synced repository.
import { dirname, join } from 'node:path';
import { EventStore } from './plan/store.ts';
import { Planner } from './plan/planner.ts';
import { SyncManager } from './plan/sync.ts';
import { CalendarFeeds } from './calendar/feeds.ts';
import { MeetingImport } from './calendar/meetings.ts';
import { GitHubSource } from './github/github.ts';
import { LinearWorkspaces } from './linear/workspaces.ts';
import { GoogleAccounts } from './google/accounts.ts';
import { GoogleData } from './google/data.ts';
import { GmailActions } from './google/gmail.ts';
import { GoogleContacts } from './google/contacts.ts';
import { GoogleCalendars, GoogleDueTasks, GoogleTimeboxes } from './google/timeboxes.ts';
import { TaskNotifications } from './google/notifications.ts';
import { GoogleSeries } from './google/series.ts';
import { MeetingDecliner } from './google/decline.ts';
import { CommandFiles, OpenCodeInfo, opencodeConfigDir } from './agents/agents.ts';

/** What every route works with. */
export type Context = Awaited<ReturnType<typeof buildContext>>;

/** Build the service over the plan's data folder `dir`; nothing runs on its own yet (main.ts starts it). */
export const buildContext = async (dir: string, log: (message: string) => void) => {
  // Each commit schedules a sync, once there is one.
  let sync: SyncManager | null = null;
  const store = new EventStore({ dir, log, onCommit: () => sync?.schedule() });
  await store.init();
  const planner = new Planner(store);
  sync = new SyncManager(store, planner, log);
  await sync.init();
  const github = new GitHubSource();
  // Feed copies are a cache, kept beside the git-tracked data rather than in it.
  const feeds = new CalendarFeeds(join(dirname(dir), 'cache'));
  // Linear API keys stay on this machine: beside the data, never in its synced repository.
  const linearWorkspaces = new LinearWorkspaces(join(dirname(dir), 'linear-workspaces.json'), undefined, log);
  // Google's client secret and refresh tokens likewise stay beside the data, never in it.
  const google = new GoogleAccounts(join(dirname(dir), 'google-accounts.json'), undefined, undefined, log);
  const googleData = new GoogleData(google);
  const gmail = new GmailActions(google);
  const contacts = new GoogleContacts(google);
  const googleCalendars = new GoogleCalendars(googleData);
  // Sunsama's meeting import: ended meetings completed, auto-sync's meetings added, followed and removed.
  const meetings = new MeetingImport(planner, googleCalendars, log);
  const googleDueTasks = new GoogleDueTasks(googleData);
  const timeboxes = new GoogleTimeboxes(planner, googleData, { idle: () => sync.idle(), log, onWrite: () => googleCalendars.forget() });
  // The task notifications given so far stay on this machine, beside the data, never in its synced repository.
  const taskNotifications = new TaskNotifications(join(dirname(dir), 'task-notifications.json'), () => planner.state, {
    accounts: () => google.emailsWith('tasks'),
    due: (accounts, from, to) => googleDueTasks.read(accounts, from, to, false),
    byIds: (groups) => googleDueTasks.byIds(groups, false),
  });
  // Repeating Google tasks: one change of a series at a time, whichever window asks.
  const series = new GoogleSeries(planner, googleData, { idle: () => sync.idle(), log, onWrite: () => googleDueTasks.forget() });
  // "Automatically decline meetings" for Busy tasks of work and school accounts; what was declined stays beside the data.
  const decliner = new MeetingDecliner(
    join(dirname(dir), 'declined-meetings.json'),
    () => planner.state,
    {
      accounts: async () => (await google.status()).accounts.filter((account) => account.workspace && account.features.includes('calendar') && account.features.includes('tasks')).map((account) => account.email),
      byIds: (groups) => googleDueTasks.byIds(groups, true),
    },
    googleData,
    { log, onDeclined: () => googleCalendars.forget() },
  );
  // Agents to assign tasks to: one OpenCode command per preset, in OpenCode's own config folder.
  const opencodeInfo = new OpenCodeInfo();
  const agentCommands = new CommandFiles(opencodeConfigDir(), log);
  return {
    log,
    store,
    planner,
    sync,
    /** The plan as a window gets it: the planner's snapshot, and the sync's status. */
    snapshot: () => ({ ...planner.snapshot(), sync: sync.status() }),
    /** The plan's time zone (UTC until it has one). */
    zone: () => planner.state.settings.timezone ?? 'UTC',
    feeds,
    meetings,
    github,
    linearWorkspaces,
    google,
    googleData,
    gmail,
    contacts,
    googleCalendars,
    googleDueTasks,
    timeboxes,
    taskNotifications,
    series,
    decliner,
    opencodeInfo,
    agentCommands,
    /** A command for every agent preset, after a change that may have changed them. */
    syncAgentCommands: () => agentCommands.syncPresets(planner.state.settings.agentPresets ?? []),
  };
};
