// Area A, the plan (tasks, days, rituals, history), over the shared harness (planner.ts): the plan's days in a zone
// whose midnight is hours away, tasks made through the service, Planner windows whose commands can be held on their
// way (as review 12's reviewer held one), a two-window race and a two-window Undo, what the Add task field and the
// Braindump modal do with what is typed (their glue lives in components, so it is repeated here, step for step, over
// the panel's own builders), and the chat's agent: the chat Ask Planner, Braindump and the Daily highlights summary
// start, and the Planner's command line run as that chat's agent runs it.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { HostClient } from '@openchamber/sdk';
import { parseBraindump, type DumpItem } from '../../src/domain/assistant/braindump.ts';
import { addDays } from '../../src/domain/core/dates.ts';
import type { EventBody, SubtaskConflict } from '../../src/domain/core/events.ts';
import { newId } from '../../src/domain/core/ids.ts';
import { parseQuickAdd } from '../../src/domain/plan/quickAdd.ts';
import type { Placement, PlannerState, Subtask } from '../../src/domain/core/types.ts';
import { braindumpRequest, highlightsLabel, highlightsRequest, startAsk } from '../../panel/lib/assistant/ask.ts';
import { addParsedTask } from '../../panel/lib/core/addTask.ts';
import { createManyTaskCommands } from '../../src/domain/plan/commands.ts';
import type { Planner, PlannerWindow, WindowOptions } from './planner.ts';

const minutesIn = (zone: string, at = Date.now()): number => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(at)).map((part) => [part.type, Number(part.value)]));
  return (parts.hour! % 24) * 60 + parts.minute!;
};

/** The plan's zone: one where it is between 2 AM and 10 PM now, so no midnight passes while the suite runs. */
export const ZONE = ['America/Los_Angeles', 'Europe/Berlin', 'Asia/Shanghai', 'Pacific/Auckland', 'America/New_York'].find((zone) => minutesIn(zone) >= 120 && minutesIn(zone) < 1320) ?? 'UTC';

export const day = (date: string): Placement => ({ kind: 'day', date });
export const backlog: Placement = { kind: 'backlog', bucket: 'next-weeks' };

/** Today in the plan, as the service has it, and the days around it. */
export const daysOf = async (planner: Planner) => {
  const today = (await planner.call('GET', '/health')).body.today as string;
  return { today, yesterday: addDays(today, -1), tomorrow: addDays(today, 1), at: (offset: number) => addDays(today, offset) };
};

let position = 0;
/** A task of the test's own, made through the service (on `placement`, below the ones made before). */
export const makeTask = async (planner: Planner, title: string, placement: Placement, extra: Record<string, unknown> = {}): Promise<string> => {
  const id = newId();
  await planner.commands({ type: 'task.created', task: { id, title, placement, position: 1024 * ++position, ...extra } } as EventBody);
  return id;
};

/** A subtask, with a fresh id. */
export const sub = (title: string, extra: Partial<Subtask> = {}): Subtask => ({ id: newId(), title, done: false, ...extra });

/** A Planner window whose commands to the service can be held on their way (`hold`), and sent unchanged once released. */
export type HeldWindow = PlannerWindow & { hold(): void; release(): void };

export const holdable = async (planner: Planner, options?: WindowOptions): Promise<HeldWindow> => {
  const window = await planner.window(options);
  const send = window.host.serviceRequest.bind(window.host);
  let gate: Promise<void> | null = null;
  let open = () => {};
  (window.host as { serviceRequest: HostClient['serviceRequest'] }).serviceRequest = async (request) => {
    if (gate && request.method === 'POST' && request.path === '/commands') await gate;
    return send(request);
  };
  return Object.assign(window, {
    hold: () => void (gate = new Promise<void>((resolve) => (open = resolve))),
    release: () => {
      open();
      gate = null;
    },
  });
};

/**
 * A's commands held on their way while B's are accepted, then A's sent as they were: what each window was told of a
 * conflict, and the plan as the service and both windows (reloaded) have it.
 */
export const race = async (planner: Planner, a: HeldWindow, b: PlannerWindow, mine: EventBody[], theirs: EventBody[]) => {
  const told = { a: [] as SubtaskConflict[], b: [] as SubtaskConflict[] };
  a.hold();
  const sent = a.client.dispatch(mine, { onConflict: (conflict) => told.a.push(conflict) });
  await b.client.dispatch(theirs, { onConflict: (conflict) => told.b.push(conflict) });
  a.release();
  await sent;
  const service = await planner.state();
  await Promise.all([a.client.refresh(), b.client.refresh()]);
  return { told, service, a: a.client.getView(), b: b.client.getView() };
};

/**
 * One window acts, offering Undo; another (which has looked since) changes something; then the first one's Undo. What
 * it offered and said, how many events the Undo wrote, and the plan after it.
 */
export const undoAfter = async (planner: Planner, act: EventBody[], label: string, theirs: EventBody[] = []) => {
  const a = await planner.window();
  const b = await planner.window();
  await a.client.dispatch(act, { undo: label });
  const offered = a.client.getView().undoLabel;
  await b.client.refresh();
  if (theirs.length) await b.client.dispatch(theirs);
  const version = (await planner.state()).version;
  await a.client.undo();
  const state = await planner.state();
  return { offered, said: a.client.getView().error, written: state.version - version, state, a };
};

/** A line typed into Add task and Enter, as the field submits it (on today unless the line says when). */
export const addTask = (window: PlannerWindow, line: string, placement?: Placement) => {
  const { today } = window.client.getView();
  return addParsedTask({ client: window.client, linear: window.linear, github: window.github, google: window.google }, parseQuickAdd(line, today), placement ?? day(today), 'bottom', today);
};

/** Braindump → One task per line → Add (in `folderId`, when it was opened in a folder), as the modal does. */
export const braindump = async (window: PlannerWindow, text: string, folderId: string | null = null): Promise<DumpItem[]> => {
  const { state, today } = window.client.getView();
  const fallback: Placement = backlog;
  const items = parseBraindump(text, today, state.settings.weekStartsOn, fallback);
  const inputs = items.map((item) => ({ title: item.title.trim(), plannedMinutes: item.plannedMinutes, placement: item.placement, channel: item.channel, priority: item.priority, objective: null }));
  await window.client.dispatch(createManyTaskCommands(state, inputs, fallback, { today, folderId }), { undo: `Added ${inputs.length} tasks` });
  return items;
};

/** Braindump → Organize with the agent, as the modal does: the chat it started for the notes. */
export const braindumpWithAgent = async (window: PlannerWindow, notes: string, folder: string | null = null) => {
  const started = await startAsk(window.host, window.client, braindumpRequest(notes, folder), { label: `Braindump: ${notes.trim().split('\n')[0]!.trim()}` });
  return { ...started, chat: window.started.at(-1)! };
};

/** Daily highlights → Summarize with the agent, as the page does: the chat it started for the day. */
export const summarizeWithAgent = async (window: PlannerWindow, date: string) => {
  const started = await startAsk(window.host, window.client, highlightsRequest(date), { label: highlightsLabel(date) });
  return { ...started, chat: window.started.at(-1)! };
};

/** Ask Planner → Ask, as the dialog does: the chat OpenChamber started for it (its first message, its chip). */
export const askPlanner = async (window: PlannerWindow, request: string) => {
  const started = await startAsk(window.host, window.client, request);
  return { ...started, chat: window.started.at(-1)! };
};

/**
 * The Planner's command line, run as the agent of chat `session` runs it with its shell (OpenCode sets
 * `OPENCODE_SESSION_ID`): the launcher the service wrote beside the plan, as the chat's first message names it.
 */
export const plannerCli = (planner: Planner, session: string | null, ...args: string[]): { code: number | null; out: string; err: string } => {
  const result = spawnSync(join(planner.home, 'bin', 'planner'), args, { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: planner.home, ...(session ? { OPENCODE_SESSION_ID: session } : {}) }, encoding: 'utf8', timeout: 20_000 });
  return { code: result.status, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
};

/** The titles of a day's tasks (neither deleted nor archived), top to bottom. */
export const dayList = (state: PlannerState, date: string): string[] =>
  Object.values(state.tasks)
    .filter((task) => !task.deletedAt && !task.archivedAt && task.placement.kind === 'day' && task.placement.date === date)
    .sort((a, b) => a.position - b.position)
    .map((task) => task.title);
