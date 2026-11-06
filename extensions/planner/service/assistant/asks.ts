// Ask Planner's side of the service: what lets the chat's agent in, and what it did. Each Ask the panel starts is a
// run (the request, the chat it became); the changes an agent makes with the Planner's command line are kept under the
// run of its chat (OpenCode's shell tells the command which chat runs it, `OPENCODE_SESSION_ID`), so the Planner can
// list them and take them back. A chat the Planner did not start gets a run when it first changes the plan.
//
// Beside the plan's data, never in its synced repository: the agent key and the address (`agent.json`, readable by
// this user only, written anew at each start), the launcher the agent runs (`bin/planner`, with the Node the service
// runs on), and the runs (`asks.json`).
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { messageOf } from '../../src/domain/core/values.ts';

/** One change an agent made: its batch (the first command, which Undo names), what it did, when, and what became of it. */
export interface AskChange {
  id: string;
  label: string;
  at: string;
  /** Taken back (`undone`), or kept because someone changed it since (`kept`). */
  undone?: 'undone' | 'kept';
}

export interface AskRun {
  id: string;
  /** What the person asked; for a chat the Planner did not start, null. */
  request: string | null;
  at: string;
  sessionId: string | null;
  directory: string | null;
  changes: AskChange[];
}

/** The runs kept, newest first, and the changes each keeps. */
const RUNS_KEPT = 30;
const CHANGES_KEPT = 200;
/** How long the agent's changes can be taken back (the service keeps what does it in memory, until it restarts). */
export const AGENT_UNDO_MS = 24 * 60 * 60 * 1000;

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export class Asks {
  /** The agent's key: opens `/agent/*` only (service/http.ts). */
  readonly key = randomBytes(24).toString('hex');
  private runs: AskRun[] = [];
  /** Why the launcher could not be written, when it could not. */
  problem: string | null = null;

  constructor(
    /** The folder holding the plan's data folder. */
    private readonly base: string,
    private readonly log: (message: string) => void,
  ) {
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { runs?: AskRun[] };
      if (Array.isArray(saved.runs)) this.runs = saved.runs;
    } catch {
      // None yet, or unreadable: start a new list.
    }
  }

  private get file(): string {
    return join(this.base, 'asks.json');
  }

  /** The command the agent runs: the launcher's absolute path. */
  get launcher(): string {
    return join(this.base, 'bin', 'planner');
  }

  /**
   * Write the agent's key and address, and the launcher that runs the command line (`cli`) with `node`, once the
   * service listens on `port`.
   */
  prepare(port: number, node: string, cli: string): void {
    try {
      mkdirSync(join(this.base, 'bin'), { recursive: true });
      const agentFile = join(this.base, 'agent.json');
      const draft = `${agentFile}.${process.pid}.tmp`;
      writeFileSync(draft, `${JSON.stringify({ url: `http://127.0.0.1:${port}`, key: this.key, pid: process.pid })}\n`, { mode: 0o600 });
      chmodSync(draft, 0o600);
      renameSync(draft, agentFile);
      const script = [
        '#!/bin/sh',
        "# The Planner's command line, for the agent working on the plan (Ask Planner). Written by the Planner's service at",
        '# each start; run it with "help" to see what it does.',
        `PLANNER_AGENT_FILE=${quote(agentFile)} exec ${quote(node)} ${quote(cli)} "$@"`,
        '',
      ].join('\n');
      const launcherDraft = `${this.launcher}.${process.pid}.tmp`;
      writeFileSync(launcherDraft, script, { mode: 0o755 });
      chmodSync(launcherDraft, 0o755);
      renameSync(launcherDraft, this.launcher);
      this.problem = null;
    } catch (error) {
      this.problem = `could not write the Planner's command line: ${messageOf(error)}`;
      this.log(this.problem);
    }
  }

  /** Whether the launcher is there to run. */
  get ready(): boolean {
    return !this.problem && existsSync(this.launcher);
  }

  /** A new run for a request the person asked. */
  start(request: string): AskRun {
    const run: AskRun = { id: randomBytes(6).toString('hex'), request, at: new Date().toISOString(), sessionId: null, directory: null, changes: [] };
    this.runs = [run, ...this.runs].slice(0, RUNS_KEPT);
    this.save();
    return run;
  }

  /**
   * The chat a run became. Its agent may have changed the plan before the panel heard which chat it is (the first
   * message goes out before OpenChamber answers): those changes join the run.
   */
  attach(runId: string, sessionId: string, directory: string | null): AskRun | null {
    const run = this.runs.find((entry) => entry.id === runId);
    if (!run) return null;
    const early = this.runs.find((entry) => entry !== run && entry.request === null && entry.sessionId === sessionId);
    if (early) {
      run.changes = [...early.changes, ...run.changes].sort((a, b) => a.at.localeCompare(b.at)).slice(-CHANGES_KEPT);
      this.runs = this.runs.filter((entry) => entry !== early);
    }
    run.sessionId = sessionId;
    run.directory = directory;
    this.save();
    return run;
  }

  run(runId: string): AskRun | null {
    return this.runs.find((entry) => entry.id === runId) ?? null;
  }

  /**
   * The run of a chat (null: the command line run outside a chat), made when that chat first changes the plan. An Ask
   * whose chat is not known yet is no one's run.
   */
  runOf(sessionId: string | null): AskRun {
    const found = this.runs.find((entry) => entry.sessionId === sessionId && (sessionId !== null || entry.request === null));
    if (found) return found;
    const run: AskRun = { id: randomBytes(6).toString('hex'), request: null, at: new Date().toISOString(), sessionId, directory: null, changes: [] };
    this.runs = [run, ...this.runs].slice(0, RUNS_KEPT);
    return run;
  }

  /** A change a chat's agent made. */
  record(sessionId: string | null, change: AskChange): AskRun {
    const run = this.runOf(sessionId);
    run.changes = [...run.changes, change].slice(-CHANGES_KEPT);
    this.save();
    return run;
  }

  /** What became of a change taken back, or kept. */
  mark(changeId: string, undone: AskChange['undone']): void {
    for (const run of this.runs) for (const change of run.changes) if (change.id === changeId) change.undone = undone;
    this.save();
  }

  /** The newest runs first. */
  recent(limit = 10): AskRun[] {
    return this.runs.slice(0, limit);
  }

  private save(): void {
    try {
      const draft = `${this.file}.${process.pid}.tmp`;
      writeFileSync(draft, `${JSON.stringify({ runs: this.runs }, null, 1)}\n`, { mode: 0o600 });
      renameSync(draft, this.file);
    } catch (error) {
      this.log(`Ask Planner: could not save its runs: ${messageOf(error)}`);
    }
  }
}
