// The Planner's command line, for the agent Ask Planner hands a request to: the chat's own agent (OpenCode, through
// OpenChamber) runs it with its shell tool, reads the plan as text and changes it with operations the service checks
// against the plan. It finds the running service in the file its launcher names (`PLANNER_AGENT_FILE`, written by the
// service at each start: the address and a key that opens only the agent's routes), and tells the service which chat
// runs it (OpenCode's shell sets `OPENCODE_SESSION_ID`), so the Planner keeps each chat's changes and can take them
// back. Built to service/cli.js next to the service; the launcher runs it with the Node the service runs on.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { addDays, isDateKey, weekdayName } from '../../src/domain/core/dates.ts';
import type { DateKey, PlannerState } from '../../src/domain/core/types.ts';
import { backlogText, channelsText, dayText, findText, taskText, weekText, type AgentEvent } from '../../src/domain/assistant/assistant.ts';

const HELP = (today: string) => `planner: the Planner's command line, for an agent working on the person's plan (Ask Planner in OpenChamber).
${today}
Tasks are named by the id in [brackets]; days are dates; times are 24-hour HH:MM in the plan's time zone.

Read
  planner show [today|tomorrow|YYYY-MM-DD|week|backlog]  a day's tasks, sessions and calendar events (default today)
  planner find <words>                                   open tasks, and ones done in 30 days, holding every word
  planner task <id>                                      one task in full: notes, subtasks, sessions, where it is from
  planner channels                                       the channels a task can be in

Change (each prints what it did and its change id; nothing is ever deleted)
  planner add <title> [--when W] [--minutes N] [--channel NAME] [--priority P] [--due D] [--notes TEXT]
  planner move <id>... --to W
  planner done <id>...     planner reopen <id>...     planner archive <id>...
  planner estimate <id> <minutes|none>
  planner channel <id> <name|none>
  planner rename <id> <title>
  planner notes <id> <text> [--append]
  planner due <id> <D|none>
  planner priority <id> <urgent|high|medium|low|none>
  planner subtask <id> <title> [--minutes N]
  planner schedule <id> <HH:MM> [--day D] [--minutes N]   a working session on the calendar; plans the task that day
  planner undo [<change>]                                 take back this chat's last change, or the one named

W: today, tomorrow, a date YYYY-MM-DD, or a backlog bucket: next-weeks, next-month, next-quarter, next-year, someday, never.
D: today, tomorrow or a date YYYY-MM-DD. P: urgent, high, medium or low.

Work like this: read before you change; change only what the person asked for; when a request is unclear, ask them
instead of guessing; archive what they no longer want; end with a short list of what you changed.`;

class Stop extends Error {}
const fail = (message: string): never => {
  throw new Stop(message);
};

type Agent = { url: string; key: string };

const agentFile = (): string => process.env.PLANNER_AGENT_FILE || join(process.env.HOME || homedir(), '.local', 'share', 'openchamber-planner', 'agent.json');

const readAgent = (): Agent => {
  try {
    const agent = JSON.parse(readFileSync(agentFile(), 'utf8')) as Partial<Agent>;
    if (typeof agent.url === 'string' && typeof agent.key === 'string') return { url: agent.url, key: agent.key };
  } catch {
    // Said below.
  }
  return fail('the Planner has not started on this machine yet: open the Planner in OpenChamber, then run this again');
};

const call = async <T>(agent: Agent, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(`${agent.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${agent.key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return fail('the Planner is not running: open the Planner in OpenChamber, then run this again');
  }
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: said below.
  }
  if (response.status === 401) fail('the Planner did not take its key: it may have restarted; run this again');
  if (!response.ok) fail((data as { error?: string } | null)?.error ?? `the Planner answered ${response.status}`);
  return data as T;
};

type Plan = { state: PlannerState; today: DateKey | null; zone: string; now: string };

const plan = async (agent: Agent): Promise<Plan & { today: DateKey }> => {
  const answer = await call<Plan>(agent, 'GET', '/agent/state');
  if (!answer.today) fail('the plan has no time zone yet: open the Planner once');
  return answer as Plan & { today: DateKey };
};

const calendar = async (agent: Agent, from: DateKey, to: DateKey): Promise<Record<string, AgentEvent[] | null>> =>
  (await call<{ days: Record<string, AgentEvent[] | null> }>(agent, 'GET', `/agent/calendar?from=${from}&to=${to}`)).days;

/** Positional words and `--name value` / `--name=value` flags; `--append` stands alone. */
const parse = (args: readonly string[]) => {
  const words: string[] = [];
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith('--') || arg === '--') {
      words.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (name === 'append') flags.append = 'yes';
    else if (inline !== undefined) flags[name] = inline;
    else if (index + 1 < args.length) flags[name] = args[++index]!;
    else fail(`--${name} needs a value`);
  }
  return { words, flags };
};

const minutesArg = (value: string | undefined, what = 'minutes'): number | null | undefined => {
  if (value === undefined) return undefined;
  if (value === 'none') return null;
  const minutes = /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(minutes) ? minutes : fail(`${what} must be a whole number of minutes, or none`);
};

const noneOr = (value: string): string | null => (value === 'none' ? null : value);

const need = (value: string | undefined, usage: string): string => value ?? fail(`usage: planner ${usage}`);

/** The operations a change command asks for. */
const opsOf = (command: string, words: string[], flags: Record<string, string>): unknown[] => {
  const [id, ...rest] = words;
  const all = (usage: string) => (words.length ? words : fail(`usage: planner ${usage}`));
  switch (command) {
    case 'add': {
      const title = words.join(' ').trim() || fail('usage: planner add <title> [--when W] [--minutes N] [--channel NAME] [--priority P] [--due D] [--notes TEXT]');
      return [{ op: 'add', title, when: flags.when ?? null, minutes: minutesArg(flags.minutes) ?? null, channel: flags.channel ?? null, priority: flags.priority ?? null, due: flags.due ?? null, notes: flags.notes ?? null }];
    }
    case 'move': {
      const to = flags.to ?? flags.when ?? fail('usage: planner move <id>... --to W');
      return all('move <id>... --to W').map((taskId) => ({ op: 'move', taskId, when: to }));
    }
    case 'done':
    case 'reopen':
    case 'archive':
      return all(`${command} <id>...`).map((taskId) => ({ op: command, taskId }));
    case 'estimate':
      return [{ op: 'estimate', taskId: need(id, 'estimate <id> <minutes|none>'), minutes: minutesArg(need(rest[0], 'estimate <id> <minutes|none>')) }];
    case 'channel':
      return [{ op: 'channel', taskId: need(id, 'channel <id> <name|none>'), channel: noneOr(need(rest[0], 'channel <id> <name|none>')) }];
    case 'rename':
      return [{ op: 'rename', taskId: need(id, 'rename <id> <title>'), title: rest.join(' ').trim() || fail('usage: planner rename <id> <title>') }];
    case 'notes':
      return [{ op: 'notes', taskId: need(id, 'notes <id> <text> [--append]'), notes: rest.join(' '), append: flags.append === 'yes' }];
    case 'due':
      return [{ op: 'due', taskId: need(id, 'due <id> <D|none>'), due: noneOr(need(rest[0], 'due <id> <D|none>')) }];
    case 'priority':
      return [{ op: 'priority', taskId: need(id, 'priority <id> <urgent|high|medium|low|none>'), priority: noneOr(need(rest[0], 'priority <id> <urgent|high|medium|low|none>')) }];
    case 'subtask':
      return [{ op: 'subtask', taskId: need(id, 'subtask <id> <title> [--minutes N]'), title: rest.join(' ').trim() || fail('usage: planner subtask <id> <title> [--minutes N]'), minutes: minutesArg(flags.minutes) ?? null }];
    case 'schedule':
      return [{ op: 'schedule', taskId: need(id, 'schedule <id> <HH:MM> [--day D] [--minutes N]'), start: need(rest[0], 'schedule <id> <HH:MM> [--day D] [--minutes N]'), date: flags.day ?? null, minutes: minutesArg(flags.minutes) ?? null }];
  }
  return fail(`unknown command "${command}": planner help lists them`);
};

const run = async (args: readonly string[]): Promise<string> => {
  const [command = 'help', ...more] = args;
  const { words, flags } = parse(more);
  const session = process.env.OPENCODE_SESSION_ID || null;
  if (command === 'help' || command === '--help' || command === '-h') {
    let today = '';
    try {
      const { today: date, zone, now } = await plan(readAgent());
      today = `Today is ${weekdayName(date)} ${date}, ${now} now (${zone}).`;
    } catch (error) {
      today = `(${error instanceof Stop ? error.message : String(error)})`;
    }
    return HELP(today);
  }
  const agent = readAgent();
  if (command === 'show') {
    const { state, today, zone, now } = await plan(agent);
    const which = words[0] ?? 'today';
    if (which === 'backlog') return backlogText(state);
    if (which === 'week') {
      const days = await calendar(agent, today, addDays(today, 6));
      return weekText(state, today, (date) => days[date] ?? null, zone, now);
    }
    const date = which === 'today' ? today : which === 'tomorrow' ? addDays(today, 1) : isDateKey(which) ? which : fail('usage: planner show [today|tomorrow|YYYY-MM-DD|week|backlog]');
    const days = await calendar(agent, date, date);
    return dayText(state, date, today, days[date] ?? null, zone, now);
  }
  if (command === 'find') {
    const { state, today } = await plan(agent);
    return findText(state, words.join(' '), today);
  }
  if (command === 'task') {
    const { state, today, zone } = await plan(agent);
    return taskText(state, need(words[0], 'task <id>').replace(/^\[|\]$/g, ''), today, zone);
  }
  if (command === 'channels') return channelsText((await plan(agent)).state);
  if (command === 'undo') {
    const answer = await call<{ undone: string }>(agent, 'POST', '/agent/undo', { session, ...(words[0] ? { change: words[0] } : {}) });
    return `Took back: ${answer.undone}`;
  }
  // Ids may come with their brackets, as the plan shows them: the first word of a task's command, every word of one
  // that takes only ids.
  const unbracket = (word: string, index: number): string => (command !== 'add' && (index === 0 || ['move', 'done', 'reopen', 'archive'].includes(command)) ? word.replace(/^\[|\]$/g, '') : word);
  const ops = opsOf(command, words.map(unbracket), flags);
  const answer = await call<{ change: { id: string; label: string } }>(agent, 'POST', '/agent/ops', { ops, session });
  return `${answer.change.label} (change ${answer.change.id})`;
};

try {
  console.log(await run(process.argv.slice(2)));
} catch (error) {
  console.error(`planner: ${error instanceof Stop ? error.message : error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
