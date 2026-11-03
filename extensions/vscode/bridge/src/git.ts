// The Git extension's API (`vscode.git`, version 1), as the bridge uses it: one window has one Git model, each part
// here has its own (its extension host's Git). When one part's repository changes (a stage, a commit, a checkout),
// the others run `git status` on theirs: the rail's Source Control follows what the page did, and the reverse.
import * as vscode from 'vscode';
import type { Bus } from './bus.ts';
import { gitFingerprint, type GitStateData } from './wire.ts';

export interface Commit {
  hash: string;
  message: string;
  parents: string[];
  authorName?: string;
  authorDate?: Date;
}

export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: GitStateData & { readonly onDidChange: vscode.Event<void> };
  status(): Promise<void>;
  log(options: { path?: string; maxEntries?: number }): Promise<Commit[]>;
}

export interface GitApi {
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  getRepository(uri: vscode.Uri): GitRepository | null;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

let api: Promise<GitApi | null> | null = null;

/** The Git extension's API in this part, started if it isn't. */
export const gitApi = (): Promise<GitApi | null> => {
  api ??= (async () => {
    const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
    if (!extension) return null;
    const exports = extension.isActive ? extension.exports : await extension.activate();
    return exports?.getAPI(1) ?? null;
  })().catch(() => null);
  return api;
};

export const startGitSync = (bus: Bus, context: vscode.ExtensionContext, log: (line: string) => void): void => {
  /** Per repository: the state last seen on the bus or here, so that a refresh to it isn't announced again. */
  const known = new Map<string, string>();
  const watch = (repository: GitRepository): void => {
    const root = repository.rootUri.toString();
    known.set(root, gitFingerprint(repository.state));
    context.subscriptions.push(repository.state.onDidChange(() => {
      const now = gitFingerprint(repository.state);
      if (known.get(root) === now) return;
      known.set(root, now);
      bus.send({ type: 'git.changed', root, fingerprint: now });
    }));
  };
  void gitApi().then((git) => {
    if (!git) return;
    for (const repository of git.repositories) watch(repository);
    context.subscriptions.push(git.onDidOpenRepository(watch));
    bus.on('git.changed', async (message) => {
      const root = String(message.root);
      const repository = git.repositories.find((item) => item.rootUri.toString() === root);
      if (!repository) return;
      known.set(root, String(message.fingerprint));
      if (gitFingerprint(repository.state) === message.fingerprint) return;
      await repository.status().catch((error: unknown) => log(`git status: ${error}`));
    });
  });
};
