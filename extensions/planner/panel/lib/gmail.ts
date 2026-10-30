// Gmail beyond the panel's list, as Sunsama's Gmail integration has it: an email task's thread and the actions on it
// (Archive, Move to trash, Mark as unread), the import and completion automations (what is done to the email when it
// becomes a task and when the task is completed, or a prompt to choose), the account's labels, and the panel's labels
// and filters as one Gmail search.
import type { Command } from '../../src/domain/events.ts';
import { DEFAULT_MAIL_FILTER, gmailActionKey, mailQuery, threadIdOf, type GmailLabel, type MailFilter, type MailThread } from '../../src/domain/gmail.ts';
import type { GmailAction, PlannerState, Task, TaskSourceRef } from '../../src/domain/types.ts';
import { mergedDone, mergedImports, wasMerged } from '../../src/domain/merge.ts';
import type { Origin, PlannerClient } from './client.ts';
import type { GoogleStore } from './google.ts';

/** The question after an email becomes a task, or its task is completed, when the settings ask ("Show prompt"). */
export interface GmailPrompt {
  when: 'import' | 'complete';
  taskId: string;
  account: string;
  thread: string;
  subject: string;
  /** What the automations would do, ticked to start with. */
  actions: GmailAction[];
}

export interface ThreadState {
  loading: boolean;
  thread: MailThread | null;
  error: string | null;
}

export interface GmailView {
  /** Each account's labels, once read. */
  labels: Record<string, GmailLabel[]>;
  /** Email tasks' threads, by `account|thread`. */
  threads: Record<string, ThreadState>;
  /** The action under way on a thread. */
  busy: Record<string, string>;
  prompt: GmailPrompt | null;
  /** The panel's labels and filters. */
  filter: MailFilter;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
export const threadKey = (account: string, thread: string): string => `${account}|${thread}`;

/** An email's account and thread, by its link (a task's, or a merged subtask's), when it has both. */
export const mailOfSource = (source: TaskSourceRef | null | undefined): { account: string; thread: string; subject: string } | null => {
  if (source?.kind !== 'email' || !source.account) return null;
  const thread = threadIdOf(source);
  return thread ? { account: source.account, thread, subject: source.title ?? 'the email' } : null;
};

/** An email task's account and thread, when it has both. */
export const mailOf = (task: Pick<Task, 'source'> | undefined): { account: string; thread: string; subject: string } | null => mailOfSource(task?.source);

export class GmailStore {
  private view: GmailView = { labels: {}, threads: {}, busy: {}, prompt: null, filter: DEFAULT_MAIL_FILTER };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly client: PlannerClient, private readonly google: GoogleStore, private readonly surface: string) {
    client.onCommitted((commands, before, after, origin) => this.afterCommit(commands, before, after, origin));
  }

  getView(): GmailView {
    return this.view;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<GmailView>): void {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** The panel's labels and filters changed: the list is read again with them, as one Gmail search. */
  setFilter(patch: Partial<MailFilter>): void {
    const filter = { ...this.view.filter, ...patch };
    this.set({ filter });
    void this.google.searchMail(mailQuery(filter));
  }

  /** The query the panel's labels and filters make, for the list's first read. */
  query(): string {
    return mailQuery(this.view.filter);
  }

  /** An account's labels: Gmail's own the panel lists (Inbox, Starred…) and the user's. */
  async labels(account: string, refresh = false): Promise<GmailLabel[]> {
    const known = this.view.labels[account];
    if (known && !refresh) return known;
    const { labels } = await this.client.call<{ labels: GmailLabel[] }>('GET', `/google/mail/labels?account=${encodeURIComponent(account)}`);
    this.set({ labels: { ...this.view.labels, [account]: labels } });
    return labels;
  }

  /** An email task's thread, as Gmail has it now. */
  async loadThread(account: string, thread: string): Promise<void> {
    const key = threadKey(account, thread);
    this.set({ threads: { ...this.view.threads, [key]: { loading: true, thread: this.view.threads[key]?.thread ?? null, error: null } } });
    try {
      const answer = await this.client.call<{ thread: MailThread }>('GET', `/google/mail/thread?account=${encodeURIComponent(account)}&thread=${encodeURIComponent(thread)}`);
      this.set({ threads: { ...this.view.threads, [key]: { loading: false, thread: answer.thread, error: null } } });
    } catch (error) {
      this.set({ threads: { ...this.view.threads, [key]: { loading: false, thread: this.view.threads[key]?.thread ?? null, error: messageOf(error) } } });
    }
  }

  /** Whether the account allowed the Planner to act on its email. */
  allowed(account: string): boolean {
    return this.google.allows(account, 'mailActions');
  }

  /**
   * Do the actions to the email's thread in Gmail; what it has after shows. A thread's actions go one after another
   * (an import's automations still under way when its task is completed: the completion's follow).
   */
  act(account: string, thread: string, actions: readonly GmailAction[], label = 'Done'): Promise<boolean> {
    const key = threadKey(account, thread);
    if (!actions.length) return Promise.resolve(false);
    const done = (this.queues.get(key) ?? Promise.resolve()).then(() => this.send(account, thread, actions, label));
    const tail = done.then(() => undefined, () => undefined);
    this.queues.set(key, tail);
    void tail.then(() => this.queues.get(key) === tail && this.queues.delete(key));
    return done;
  }

  private readonly queues = new Map<string, Promise<void>>();

  private async send(account: string, thread: string, actions: readonly GmailAction[], label: string): Promise<boolean> {
    const key = threadKey(account, thread);
    this.set({ busy: { ...this.view.busy, [key]: label } });
    try {
      await this.client.call<{ labelIds: string[] }>('POST', '/google/mail/act', { account, thread, actions });
      // The task's thread and the panel's list follow (an archived email leaves the Inbox).
      if (this.view.threads[key]) void this.loadThread(account, thread);
      void this.google.searchMail();
      return true;
    } catch (error) {
      this.client.notify(`Gmail did not take it: ${messageOf(error)}`);
      return false;
    } finally {
      const busy = { ...this.view.busy };
      delete busy[key];
      this.set({ busy });
    }
  }

  answerPrompt(actions: readonly GmailAction[] | null): void {
    const prompt = this.view.prompt;
    this.set({ prompt: null });
    if (!prompt || !actions?.length) return;
    void this.act(prompt.account, prompt.thread, actions, prompt.when === 'import' ? 'Importing' : 'Completing').then((done) => done && this.client.notify(`Gmail: done for "${prompt.subject}"`));
  }

  /**
   * The automations, after the user's own changes in this window: an email that became a task, an email task
   * completed; and, as Sunsama keeps merged items integrated, an email merged straight into a task, or checked off there.
   */
  private afterCommit(commands: readonly Command[], before: PlannerState, after: PlannerState, origin: Origin): void {
    // Only the surfaces with room for the question act; the Work Status frame and the background never do.
    if (origin !== 'user' || this.surface === 'status' || this.surface === 'background') return;
    const made = commands.flatMap((command) => (command.type === 'task.created' && command.task.source ? [command.task.source] : []));
    for (const command of commands) {
      if (command.type === 'task.updated' && command.patch.subtasks) {
        for (const subtask of mergedImports(before, after, command.taskId, made)) this.automate('import', command.taskId, mailOfSource(subtask.source), after);
        for (const subtask of mergedDone(before.tasks[command.taskId], after.tasks[command.taskId])) this.automate('complete', command.taskId, mailOfSource(subtask.source), after);
        continue;
      }
      const when = command.type === 'task.created' ? 'import' : command.type === 'task.completed' ? 'complete' : null;
      if (!when) continue;
      const taskId = command.type === 'task.created' ? command.task.id : command.type === 'task.completed' ? command.taskId : '';
      // An email task made again (planned anew after a delete) is an import; one that existed before is not, nor one
      // given back by Convert to task (its email was imported when it was merged).
      if (when === 'import' && before.tasks[taskId] && !before.tasks[taskId]!.deletedAt) continue;
      if (command.type === 'task.created' && command.task.source && wasMerged(before, command.task.source)) continue;
      this.automate(when, taskId, mailOf(after.tasks[taskId]), after);
    }
  }

  /** What the settings say to do to an email in Gmail when it is imported or its task completed: ask, or do it. */
  private automate(when: 'import' | 'complete', taskId: string, mail: ReturnType<typeof mailOfSource>, after: PlannerState): void {
    if (!mail) return;
    const settings = after.settings;
    const configured = when === 'import' ? settings.gmailOnImport : settings.gmailOnComplete;
    const ask = when === 'import' ? settings.gmailImportPrompt : settings.gmailCompletePrompt;
    if (ask) {
      this.set({ prompt: { when, taskId, account: mail.account, thread: mail.thread, subject: mail.subject, actions: [...configured] } });
      return;
    }
    if (!configured.length) return;
    if (!this.allowed(mail.account)) {
      this.client.notify(`Gmail's ${when === 'import' ? 'import' : 'completion'} automations need Gmail actions for ${mail.account}: allow them in Settings → Google`);
      return;
    }
    void this.act(mail.account, mail.thread, configured, when === 'import' ? 'Importing' : 'Completing');
  }
}

/** Actions without repeats, in the order they were picked. */
export const uniqueActions = (actions: readonly GmailAction[]): GmailAction[] => [...new Map(actions.map((action) => [gmailActionKey(action), action])).values()];
