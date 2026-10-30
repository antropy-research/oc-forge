// The service's series routes for a test's fake Planner client: the service's
// own `GoogleSeries`, its Google calls answered as the test answers the
// panel's (`google`), its writes checked as commands and applied to the same
// plan. A panel test thus runs a repeating task's next occurrence, its
// upcoming occurrences changed on their own, an edit of all its tasks and its
// deletion as the service runs them. And the reads a save makes first, as the
// service answers them: the plan (`GET /state`), and tasks read again
// (`/google/tasks/linked`) from the test's Google.
import type { GoogleTaskItem } from '../src/domain/google.ts';
import { commandBody, validateCommand, type Command, type EventBody } from '../src/domain/events.ts';
import { applyEvents } from '../src/domain/reducer.ts';
import type { PlannerEvent } from '../src/domain/events.ts';
import type { PlannerState } from '../src/domain/types.ts';
import { GoogleSeries } from '../service/googleSeries.ts';
import type { ExecuteResult } from '../service/planner.ts';

const ROUTES = ['/google/tasks/next', '/google/tasks/series', '/google/tasks/occurrence', '/google/tasks/series/edit', '/google/tasks/gone'];

export const seriesRoutes = (plan: { state(): PlannerState; apply(bodies: EventBody[]): void }, google: (method: string, path: string, body?: unknown) => Promise<unknown>) => {
  const enc = encodeURIComponent;
  let clock = Date.parse('2026-10-26T12:00:00Z');
  const series = new GoogleSeries(
    {
      get state() {
        return plan.state();
      },
      execute: (commands: readonly unknown[]): ExecuteResult => {
        let working = plan.state();
        for (const [index, command] of commands.entries()) {
          const error = validateCommand(command, working);
          if (error) return { ok: false, error, index };
          clock += 1;
          working = applyEvents(working, [{ v: 1, id: `s${clock}`, at: new Date(clock).toISOString(), ...commandBody(command as Command) } as PlannerEvent]);
        }
        plan.apply(commands.map((command) => commandBody(command as Command)));
        return { ok: true, applied: commands.length };
      },
    },
    {
      allTasks: async (account, listId) => {
        const read = (await google('GET', `/google/tasks/all?account=${enc(account)}&list=${enc(listId)}`)) as { tasks?: GoogleTaskItem[]; complete?: boolean } | null;
        return { tasks: read?.tasks ?? [], complete: read?.complete ?? true };
      },
      createTask: async (account, listId, task) => ((await google('POST', '/google/tasks', { account, listId, ...task })) as { task?: GoogleTaskItem | null } | null)?.task ?? null,
      deleteTask: async (account, listId, id) => {
        await google('DELETE', `/google/tasks?account=${enc(account)}&list=${enc(listId)}&id=${enc(id)}`);
      },
      updateTask: async (account, listId, id, patch) => ((await google('PATCH', '/google/tasks', { account, listId, id, ...patch })) as { task?: GoogleTaskItem | null } | null)?.task ?? null,
      locateTasks: async () => [],
    },
  );
  /**
   * Tasks read again, as the service reads them: the test's own answer when it names each one (found or missing),
   * else each list as the test's Google has it. A list the test's Google does not answer is an error for its account,
   * as the service says when Google fails: never "not changed".
   */
  const linked = async (body: { groups: { account: string; listId: string; ids: string[] }[] }) => {
    const own = (await google('POST', '/google/tasks/linked', body)) as { tasks?: GoogleTaskItem[]; missing?: { id: string }[] } | null;
    const named = (id: string) => Boolean(own?.tasks?.some((task) => task.id === id) || own?.missing?.some((task) => task.id === id));
    if (body.groups.every((group) => group.ids.every(named))) return { tasks: own?.tasks ?? [], missing: own?.missing ?? [], errors: [] };
    const tasks: GoogleTaskItem[] = [];
    const missing: { account: string; listId: string; id: string }[] = [];
    const listRead = async (account: string, listId: string) => ((await google('GET', `/google/tasks/all?account=${enc(account)}&list=${enc(listId)}`)) as { tasks?: GoogleTaskItem[] } | null)?.tasks;
    for (const group of body.groups) {
      const read = await listRead(group.account, group.listId);
      if (!Array.isArray(read)) return { tasks, missing, errors: [{ account: group.account, message: "the test's Google has no such list" }] };
      // Not in its list: looked for in the account's other lists, as the service does (moved in Google's own apps).
      const others = group.ids.some((id) => !read.some((task) => task.id === id)) ? (((await google('GET', '/google/tasklists')) as { lists?: { account: string; id: string }[] } | null)?.lists ?? []) : [];
      const elsewhere: GoogleTaskItem[] = [];
      for (const list of others.filter((list) => list.account === group.account && list.id !== group.listId)) elsewhere.push(...((await listRead(group.account, list.id)) ?? []));
      for (const id of group.ids) {
        const found = read.find((task) => task.id === id) ?? elsewhere.find((task) => task.id === id);
        if (found) tasks.push(found);
        else missing.push({ account: group.account, listId: group.listId, id });
      }
    }
    return { tasks, missing, errors: [] };
  };
  /** The answer to one of the series routes, with the plan as it is then (and to the reads above); null for any other path. */
  const handle = async (path: string, body?: any): Promise<object | null> => {
    const route = path.split('?')[0]!;
    if (route === '/state') return { state: plan.state() };
    if (route === '/google/tasks/linked') return linked(body);
    if (!ROUTES.includes(route)) return null;
    const query = new URLSearchParams(path.split('?')[1] ?? '');
    const { account, listId, ...input } = body ?? {};
    let done: object = {};
    if (route === '/google/tasks/next') done = await series.next(account, listId, input.id, { completed: input.completed, due: input.due });
    else if (route === '/google/tasks/series') done = await series.remove(query.get('account')!, query.get('series')!, query.get('from'), query.get('task'));
    else if (route === '/google/tasks/occurrence') await series.occurrence(account, input.seriesId, input.on, input.skip ? { skip: true } : 'restore' in input ? { restore: input.restore } : { before: input.before, after: input.after });
    else if (route === '/google/tasks/series/edit') await series.edit(account, listId, input.taskId, input.seriesId, input.own, input.before, input.after);
    else await series.gone(account, listId, input.id);
    return { ...done, state: plan.state() };
  };
  return { series, handle };
};
