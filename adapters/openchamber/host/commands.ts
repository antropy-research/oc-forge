// OpenCode 2.2 loads a folder's commands on the first request for them, and
// answers that request with none: a folder that has loaded them always lists
// its built-ins (init, review). OpenChamber looks a command up once, right
// before it sends, so the first `/name args` in a folder whose commands nobody
// asked for yet (a worktree just made, as for the Planner's assignments) went
// out as a plain prompt and never ran the command: the chat ran on the default
// agent. An empty answer is asked again until it is not, for a moment.
const RETRY_MS = 250;
const WAIT_MS = 3_000;

export const ocForgeCommandsOnceLoaded = async <T,>(list: () => Promise<T[]>, waitMs = WAIT_MS, retryMs = RETRY_MS): Promise<T[]> => {
  const end = Date.now() + waitMs;
  let commands = await list();
  while (commands.length === 0 && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, retryMs));
    commands = await list();
  }
  return commands;
};
