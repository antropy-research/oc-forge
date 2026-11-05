// The plan's routes: health, the plan as a window gets it, commands and the Planner's own Undo, a task's activity,
// and git sync with a remote.
import { messageOf } from '../../src/domain/core/values.ts';
import { CHANGED_SINCE, UNDO_GONE } from '../../src/domain/plan/undo.ts';
import type { SyncStatus } from '../plan/sync.ts';
import { bad, ok, readJson, type Route } from '../http.ts';

/** How long "Sync now" waits for the sync before answering; well inside the time OpenChamber waits for a service. */
const SYNC_ANSWER_MS = 20_000;

export const planRoute: Route = async ({ planner, sync, snapshot, syncAgentCommands }, req, url) => {
  const path = url.pathname;
  if (path === '/health' && req.method === 'GET') return ok({ ok: true, version: planner.state.version, today: planner.today() });
  if (path === '/state' && req.method === 'GET') return ok(snapshot());
  if (path === '/sync') {
    if (req.method === 'GET') return ok(sync.status());
    if (req.method === 'PUT') {
      const body = (await readJson(req)) as { remote?: unknown };
      if (body.remote !== null && typeof body.remote !== 'string') return bad('remote must be a string or null');
      try {
        return ok(await sync.setRemote(body.remote));
      } catch (error) {
        return bad(messageOf(error));
      }
    }
    if (req.method === 'POST') {
      // Answer within the time OpenChamber waits for a service (a first push of a long history can take longer):
      // a sync still running answers `syncing`, and the panel follows it to its end.
      const done = sync.run().catch((error) => ({ ...sync.status(), lastError: messageOf(error) }));
      const status = await Promise.race([done, new Promise<SyncStatus>((resolve) => setTimeout(() => resolve(sync.status()), SYNC_ANSWER_MS).unref?.())]);
      return ok({ status, ...snapshot() }, syncAgentCommands);
    }
  }
  if (path === '/activity' && req.method === 'GET') {
    const taskId = url.searchParams.get('task') ?? '';
    return ok({ events: planner.activity(taskId) });
  }
  if (path === '/commands' && req.method === 'POST') {
    const body = (await readJson(req)) as { commands?: unknown; undo?: unknown };
    if (!Array.isArray(body.commands)) return bad('commands must be an array');
    // A sync may be merging events from another machine; let it finish first.
    await sync.idle();
    // `undo`: the window offers Undo for this batch, so what takes it back is kept here (`/undo`).
    const result = planner.execute(body.commands, { undo: body.undo === true });
    if (!result.ok) {
      // A subtask changed elsewhere since: 409 with what it is now and the plan as it is (theirs included), as a
      // refused Undo answers.
      if (result.conflict) return { status: 409, body: { error: result.error, index: result.index, conflict: result.conflict, ...snapshot() } };
      return { status: 400, body: { error: result.error, index: result.index } };
    }
    return ok({ applied: result.applied, ...snapshot() }, syncAgentCommands);
  }
  if (path === '/undo' && req.method === 'POST') {
    // Undo a batch sent with `undo`, named by its first command: only what nobody has changed since (409 otherwise,
    // with the plan as it is, theirs included); 410 once it can no longer be undone.
    const body = (await readJson(req)) as { batch?: unknown };
    if (typeof body.batch !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.batch)) return bad('batch must be the command id of a batch');
    await sync.idle();
    const result = planner.undo(body.batch);
    if (!result.ok) {
      return { status: result.reason === 'gone' ? 410 : 409, body: { error: result.reason === 'gone' ? UNDO_GONE : CHANGED_SINCE, changed: result.reason === 'changed' ? result.changed : [], ...snapshot() } };
    }
    return ok({ applied: result.applied, commands: result.commands, ...snapshot() }, syncAgentCommands);
  }
  return null;
};
