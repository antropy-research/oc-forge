// Linear's routes: the workspaces added with an API key (the key stays on this machine), and the Planner's GraphQL
// requests to one of them. A workspace's own errors answer with their status.
import { WorkspaceError } from '../linear/workspaces.ts';
import { bad, ok, readJson, type Route } from '../http.ts';

export const linearRoute: Route = async ({ linearWorkspaces }, req, url) => {
  if (!url.pathname.startsWith('/linear/')) return null;
  try {
    if (url.pathname === '/linear/workspaces' && req.method === 'GET') return ok({ workspaces: await linearWorkspaces.list() });
    if (url.pathname === '/linear/workspaces' && req.method === 'POST') {
      const body = (await readJson(req)) as { key?: unknown };
      if (typeof body.key !== 'string') return bad('key must be a string');
      return ok({ workspace: await linearWorkspaces.add(body.key) });
    }
    const one = /^\/linear\/workspaces\/([A-Za-z0-9_-]{1,100})$/.exec(url.pathname);
    if (one && req.method === 'DELETE') return ok({ removed: await linearWorkspaces.remove(one[1]!) });
    if (url.pathname === '/linear/graphql' && req.method === 'POST') {
      const body = (await readJson(req)) as { workspaceId?: unknown; query?: unknown; variables?: unknown };
      if (typeof body.workspaceId !== 'string' || typeof body.query !== 'string') return bad('workspaceId and query must be strings');
      return ok(await linearWorkspaces.graphql(body.workspaceId, body.query, body.variables ?? {}));
    }
    return null;
  } catch (error) {
    if (error instanceof WorkspaceError) return { status: error.status, body: { error: error.message } };
    throw error;
  }
};
