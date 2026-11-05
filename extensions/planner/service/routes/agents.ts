// The agents' routes: what a task can be assigned to (the assignee picker, Settings → Agents), and the OpenCode
// commands that start a chat as one of them.
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { isRunAssignee } from '../../src/domain/agents/assignees.ts';
import type { RunAssignee } from '../../src/domain/core/types.ts';
import { messageOf } from '../../src/domain/core/values.ts';
import { agentCatalog } from '../agents/agents.ts';
import { bad, ok, readJson, type Route } from '../http.ts';

const isDirectory = (value: unknown): value is string => typeof value === 'string' && value.length <= 1024 && isAbsolute(value);

export const agentsRoute: Route = async ({ opencodeInfo, agentCommands }, req, url) => {
  if (url.pathname === '/agents' && req.method === 'GET') {
    const directory = url.searchParams.get('directory');
    if (directory !== null && !isDirectory(directory)) return bad('directory must be an absolute path');
    return ok(await agentCatalog(agentCommands.configDir, opencodeInfo, directory, url.searchParams.get('refresh') === '1'));
  }
  if (url.pathname === '/agents/commands' && req.method === 'POST') {
    const body = (await readJson(req)) as { entries?: unknown; directory?: unknown; wait?: unknown };
    const entries = Array.isArray(body.entries) ? body.entries : [];
    if (entries.length > 40 || !entries.every((entry) => isRunAssignee((entry as { assignee?: unknown })?.assignee) && ['preset', 'agent'].includes((entry as { kind?: unknown }).kind as string))) {
      return bad('entries must be at most 40 of { assignee, kind: preset | agent }');
    }
    if (body.directory !== undefined && body.directory !== null && !isDirectory(body.directory)) return bad('directory must be an absolute path');
    let commands: { id: string; name: string; changed: boolean }[];
    try {
      commands = agentCommands.ensure(entries as { assignee: RunAssignee; kind: 'preset' | 'agent' }[]);
    } catch (error) {
      return { status: 409, body: { error: `Could not write the agent command in ${agentCommands.dir}: ${messageOf(error)}` } };
    }
    const listed = body.wait === true && commands.length ? await opencodeInfo.waitListed(commands.map((command) => command.name), (body.directory as string | undefined) ?? homedir()) : null;
    return ok({ commands, listed, dir: agentCommands.dir });
  }
  return null;
};
