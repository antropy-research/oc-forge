// Add Task submit shared by the inline form and the A window. A URL pasted
// alone as the title is taken as Sunsama's "Add via URL" takes it: a Linear
// issue, a GitHub issue or pull request and a Gmail message become a task
// linked to them (their title, state and address); a Google Calendar event is
// planned as "Plan as task" plans it; any other page becomes a task with that
// page as its backlink. One that can't be looked up becomes the backlink task,
// and the Planner says why.
import type { QuickAdd } from '../../src/domain/quickAdd.ts';
import { linkTitle, pastedUrl, type PastedUrl } from '../../src/domain/pastedUrl.ts';
import { zonedDateMinutes } from '../../src/domain/dates.ts';
import type { EventBody } from '../../src/domain/events.ts';
import type { MailItem } from '../../src/domain/google.ts';
import type { DateKey, Placement, TaskSourceRef } from '../../src/domain/types.ts';
import type { PlannerClient } from './client.ts';
import type { LinearStore } from './linear.ts';
import type { GitHubStore } from './github.ts';
import type { GoogleStore } from './google.ts';
import { eventDetail } from './gcal.ts';
import { createTaskCommands } from './commands.ts';

/** What a pasted URL is looked up in. */
export interface AddSources {
  client: PlannerClient;
  linear: LinearStore;
  github: GitHubStore;
  google: GoogleStore;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What Enter does with a URL pasted alone as the title, said under the field before it is pressed (as Sunsama suggests the import). */
export const urlHint = (title: string): string | null => {
  const url = pastedUrl(title);
  if (!url) return null;
  switch (url.kind) {
    case 'linear':
      return `Enter imports the Linear issue ${url.key}`;
    case 'github':
      return `Enter imports the GitHub ${url.item === 'pull' ? 'pull request' : 'issue'} ${url.key}`;
    case 'gmail':
      return url.thread || url.message ? 'Enter imports the email from Gmail' : "Enter links this Gmail page: Gmail's own links can't be read by other apps (Google → Gmail adds an email with its subject)";
    case 'gcal':
      return 'Enter plans the Google Calendar event as a task';
    case 'link':
      return `Enter adds a task linked to ${url.host}`;
  }
};

/** A task with the page as its backlink (Sunsama's "Tasks from URL"), titled from its address. */
const linkTaskCommands = (client: PlannerClient, parsed: QuickAdd, url: string, fallback: Placement, edge: 'top' | 'bottom', today: DateKey, folderId: string | null, look: { title?: string; key?: string; notes?: string; plannedMinutes?: number | null } = {}): EventBody[] => {
  const address = new URL(url);
  const title = look.title ?? linkTitle(address);
  const bodies = createTaskCommands(client.getView().state, { ...parsed, title, plannedMinutes: parsed.plannedMinutes ?? look.plannedMinutes ?? null }, fallback, edge, today, folderId);
  const source: TaskSourceRef = { kind: 'link', id: url.slice(0, 200), key: (look.key ?? address.hostname.replace(/^www\./, '')).slice(0, 100), url, title };
  return bodies.map((body) => (body.type === 'task.created' ? { ...body, task: { ...body.task, source, ...(look.notes ? { notes: look.notes } : {}) } } : body));
};

/** A Google Calendar event by its address, in whichever connected account can read it. */
const findEvent = async (sources: AddSources, url: Extract<PastedUrl, { kind: 'gcal' }>) => {
  const accounts = sources.google.accountsWith('calendar').map((account) => account.email);
  for (const account of accounts) {
    for (const calendarId of [url.calendarId, ...(url.calendarId === account ? ['primary'] : [])]) {
      try {
        return await eventDetail(sources.client, { account, calendarId, eventId: url.eventId } as Parameters<typeof eventDetail>[1]);
      } catch {
        // Not in this account's calendars: the next one.
      }
    }
  }
  return null;
};

/** Add a parsed line; a URL pasted alone becomes the task Sunsama's "Add via URL" makes of it. */
export const addParsedTask = async (sources: AddSources, parsed: QuickAdd, fallback: Placement, edge: 'top' | 'bottom', today: DateKey, folderId: string | null = null): Promise<void> => {
  const { client } = sources;
  const url = pastedUrl(parsed.title);
  const placement = parsed.placement ?? fallback;
  const plan = (bodies: EventBody[], taskId: string, undo: string) => {
    if (parsed.plannedMinutes) bodies.push({ type: 'task.updated', taskId, patch: { plannedMinutes: parsed.plannedMinutes } });
    return client.dispatch(bodies, { undo });
  };
  if (url?.kind === 'linear' && sources.linear.available()) {
    try {
      // The URL names its workspace, so the issue is looked up there and nowhere else.
      const issue = await sources.linear.issue(url.key, url.urlKey);
      if (issue) {
        const { bodies, taskId } = sources.linear.importCommands(issue, placement);
        return plan(bodies, taskId, `Planned ${issue.identifier}`);
      }
      client.notify(`${url.key} was not found in your connected Linear workspaces; added the link as a task`);
    } catch {
      client.notify(`Couldn't look up ${url.key} in Linear; added the link as a task`);
    }
  } else if (url?.kind === 'linear') client.notify('Linear is not connected: added the link as a task (Settings → Integrations → Linear connects it)');
  if (url?.kind === 'github') {
    if (sources.github.getView().status?.available) {
      try {
        const item = await sources.github.resolve(url.url);
        if (item) {
          const { bodies, taskId } = sources.github.importCommands(item, placement);
          return plan(bodies, taskId, `Planned ${item.key}`);
        }
        client.notify(`${url.key} was not found on GitHub, or this gh can't see it; added the link as a task`);
      } catch (error) {
        client.notify(`Couldn't look up ${url.key} on GitHub (${messageOf(error)}); added the link as a task`);
      }
    } else client.notify(`GitHub (gh) is not signed in where OpenChamber runs: added ${url.key} as a link (the GitHub source says how to sign in)`);
  }
  if (url?.kind === 'gmail' && (url.thread || url.message)) {
    try {
      // The account the address names first, then each with Gmail (the service's /google/mail/resolve).
      const { item } = await client.call<{ item: MailItem }>('POST', '/google/mail/resolve', { thread: url.thread, message: url.message, account: url.account });
      const { bodies, taskId } = sources.google.importMail(item, placement);
      return plan(bodies, taskId, `Planned "${item.subject}"`);
    } catch (error) {
      client.notify(`Couldn't find this message in Gmail (${messageOf(error)}); added the link as a task`);
    }
  } else if (url?.kind === 'gmail') client.notify("Gmail's own links can't be read by other apps: added it as a link. Google → Gmail adds the email with its subject and sender");
  if (url?.kind === 'gcal') {
    const event = await findEvent(sources, url).catch(() => null);
    if (event) {
      // As "Plan as task" plans an event: its title, its length as planned time, when it is in the details; linked back to it.
      const zone = client.getView().state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const start = event.start.dateTime ?? (event.start.date ? `${event.start.date}T00:00:00Z` : null);
      const end = event.end.dateTime ?? (event.end.date ? `${event.end.date}T00:00:00Z` : null);
      const minutes = start && end && !event.allDay ? Math.min(24 * 60, Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 60_000))) : null;
      const when = start ? `${event.allDay ? event.start.date : `${zonedDateMinutes(start, zone).date}`}, from the calendar` : 'From the calendar';
      const bodies = linkTaskCommands(client, parsed, event.htmlLink && /^https:\/\//.test(event.htmlLink) ? event.htmlLink : url.url, fallback, edge, today, folderId, { title: event.title, key: 'Google Calendar', notes: when, plannedMinutes: minutes || null });
      return client.dispatch(bodies, { undo: 'Task added from the calendar' });
    }
    client.notify('This event is in none of your connected calendars; added the link as a task');
  }
  // Any other page, or an item that could not be looked up: a task with the page as its backlink.
  if (url) return client.dispatch(linkTaskCommands(client, parsed, url.kind === 'linear' ? parsed.title.trim() : url.url, fallback, edge, today, folderId), { undo: 'Link added as a task' });
  await client.dispatch(createTaskCommands(client.getView().state, parsed, fallback, edge, today, folderId));
};
