// Ask Planner's routes. The panel's (OpenChamber's token): start a run for a request and get the command the agent
// runs, say which chat the run became, list the recent runs with their changes, and take a run's changes back. The
// agent's (its own key, service/assistant/asks.ts, never from a browser): the plan and a range of the calendar to read,
// operations to apply (checked against the plan, one undoable batch, kept under the chat that sent them), and Undo.
import { newId } from '../../src/domain/core/ids.ts';
import { addDays, daysBetween, isDateKey, zonedDateMinutes } from '../../src/domain/core/dates.ts';
import { messageOf } from '../../src/domain/core/values.ts';
import { clock, describeOps, opsCommands, readOps, type AgentEvent } from '../../src/domain/assistant/assistant.ts';
import { CHANGED_SINCE, UNDO_GONE } from '../../src/domain/plan/undo.ts';
import { AGENT_UNDO_MS, type AskRun } from '../assistant/asks.ts';
import { readCalendar } from '../calendar/range.ts';
import type { Context } from '../context.ts';
import { bad, ok, readJson, type Route } from '../http.ts';

const REQUEST_MAX = 4000;
const SESSION = /^[A-Za-z0-9_-]{1,128}$/;

/** A run as the panel lists it: each change says whether it can still be taken back. */
const runView = (ctx: Context, run: AskRun) => ({ ...run, changes: run.changes.map((change) => ({ ...change, undoable: !change.undone && ctx.planner.undoable(change.id) })) });

/** Take one change back; what became of it. */
const undoChange = (ctx: Context, changeId: string): 'undone' | 'kept' | 'gone' => {
  const result = ctx.planner.undo(changeId);
  if (result.ok) {
    ctx.asks.mark(changeId, 'undone');
    return 'undone';
  }
  if (result.reason === 'changed') ctx.asks.mark(changeId, 'kept');
  return result.reason === 'changed' ? 'kept' : 'gone';
};

export const askRoute: Route = async (ctx, req, url) => {
  const { asks, planner, sync } = ctx;
  const path = url.pathname;
  if (path === '/ask/runs' && req.method === 'GET') return ok({ runs: asks.recent().map((run) => runView(ctx, run)), launcher: asks.launcher, problem: asks.problem });
  if (path === '/ask/runs' && req.method === 'POST') {
    const body = (await readJson(req)) as { request?: unknown };
    const request = typeof body.request === 'string' ? body.request.trim() : '';
    if (!request || request.length > REQUEST_MAX) return bad(`request must be 1-${REQUEST_MAX} characters`);
    if (!asks.ready) return { status: 503, body: { error: asks.problem ?? "the Planner's command line is not ready" } };
    return ok({ run: asks.start(request), launcher: asks.launcher });
  }
  const match = /^\/ask\/runs\/([a-f0-9]{1,32})(\/undo)?$/.exec(path);
  if (match && !match[2] && req.method === 'PUT') {
    const body = (await readJson(req)) as { sessionId?: unknown; directory?: unknown };
    if (typeof body.sessionId !== 'string' || !SESSION.test(body.sessionId)) return bad('sessionId must be a chat id');
    const run = asks.attach(match[1]!, body.sessionId, typeof body.directory === 'string' ? body.directory : null);
    return run ? ok({ run: runView(ctx, run) }) : { status: 404, body: { error: 'no such run' } };
  }
  if (match && match[2] && req.method === 'POST') {
    // Newest first, each only while nobody has changed since what it would put back.
    const run = asks.run(match[1]!);
    if (!run) return { status: 404, body: { error: 'no such run' } };
    await sync.idle();
    const outcomes = [...run.changes].reverse().filter((change) => !change.undone).map((change) => ({ label: change.label, outcome: undoChange(ctx, change.id) }));
    return ok({ undone: outcomes.filter((entry) => entry.outcome === 'undone').length, kept: outcomes.filter((entry) => entry.outcome !== 'undone').map((entry) => ({ label: entry.label, why: entry.outcome === 'kept' ? CHANGED_SINCE : UNDO_GONE })), run: runView(ctx, run), ...ctx.snapshot() });
  }
  return null;
};

/** The days of a range, each with its events as the agent reads them (null: the calendars could not be read). */
const eventsByDay = async (ctx: Context, from: string, to: string): Promise<Record<string, AgentEvent[] | null>> => {
  const zone = ctx.zone();
  const days: Record<string, AgentEvent[] | null> = {};
  for (let date = from; date <= to; date = addDays(date, 1)) days[date] = [];
  try {
    const read = await readCalendar(ctx, from, to, false);
    read.reconcile();
    // No calendar at all, or every one failed: unknown, not "nothing".
    const calendars = Object.keys(ctx.planner.state.calendars).length;
    if (calendars === 0 || (read.errors.length >= calendars && read.events.length === 0)) for (const date of Object.keys(days)) days[date] = null;
    for (const event of read.events) {
      // Google tasks show as tasks, not as time taken.
      if (event.googleTask || event.pendingTasks || event.upcoming) continue;
      // An all-day event runs midnight to midnight in the plan's zone, on every day it covers.
      const first = zonedDateMinutes(event.start, zone).date;
      const end = zonedDateMinutes(event.end, zone);
      const last = event.allDay ? addDays(end.date, end.minutes === 0 ? -1 : 0) : first;
      for (let date = first; date <= last && date <= to; date = addDays(date, 1)) days[date]?.push({ title: event.title, start: event.start, end: event.end, allDay: event.allDay, busy: event.busy && !event.transparent });
    }
  } catch (error) {
    ctx.log(`Ask Planner: the calendar could not be read: ${messageOf(error)}`);
    for (const date of Object.keys(days)) days[date] = null;
  }
  return days;
};

export const agentRoute: Route = async (ctx, req, url) => {
  const { asks, planner, sync } = ctx;
  const path = url.pathname;
  if (path === '/agent/state' && req.method === 'GET') {
    const snapshot = planner.snapshot();
    // What time it is in the plan's zone, for "what I can't finish today".
    return ok({ state: snapshot.state, today: snapshot.today, zone: ctx.zone(), now: clock(zonedDateMinutes(Date.now(), ctx.zone()).minutes) });
  }
  if (path === '/agent/calendar' && req.method === 'GET') {
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    if (!isDateKey(from) || !isDateKey(to) || daysBetween(from, to) < 0 || daysBetween(from, to) > 14) return bad('from and to must be dates at most 14 days apart');
    return ok({ days: await eventsByDay(ctx, from, to) });
  }
  if (path === '/agent/ops' && req.method === 'POST') {
    const body = (await readJson(req)) as { ops?: unknown; session?: unknown };
    const session = typeof body.session === 'string' && SESSION.test(body.session) ? body.session : null;
    // A sync may be merging events from another machine; let it finish first.
    await sync.idle();
    const today = planner.today();
    if (!today) return bad('the plan has no time zone yet: open the Planner once');
    const before = planner.state;
    const read = readOps(body.ops, before, today, ctx.zone());
    if (!read.ok) return { status: 400, body: { error: read.error, index: read.index } };
    const commands = opsCommands(before, read.ops, today, ctx.zone(), newId).map((command) => ({ ...command, cmd: newId() }));
    const result = planner.execute(commands, { undo: true, keepMs: AGENT_UNDO_MS });
    if (!result.ok) return { status: result.conflict ? 409 : 400, body: { error: result.error, index: result.index } };
    const change = { id: commands[0]!.cmd, label: describeOps(before, read.ops, today), at: new Date().toISOString() };
    const run = asks.record(session, change);
    return ok({ change, run: run.id });
  }
  if (path === '/agent/undo' && req.method === 'POST') {
    const body = (await readJson(req)) as { session?: unknown; change?: unknown };
    const session = typeof body.session === 'string' && SESSION.test(body.session) ? body.session : null;
    const run = asks.runOf(session);
    const change = typeof body.change === 'string' ? run.changes.find((entry) => entry.id === body.change) : [...run.changes].reverse().find((entry) => !entry.undone);
    if (!change) return { status: 404, body: { error: typeof body.change === 'string' ? `no change ${body.change} of this chat` : 'this chat has made no change to take back' } };
    if (change.undone) return bad(`"${change.label}" was ${change.undone === 'undone' ? 'taken back' : 'kept'} already`);
    await sync.idle();
    const outcome = undoChange(ctx, change.id);
    if (outcome === 'undone') return ok({ undone: change.label });
    return { status: outcome === 'kept' ? 409 : 410, body: { error: `${outcome === 'kept' ? CHANGED_SINCE : UNDO_GONE}: "${change.label}"` } };
  }
  return null;
};
