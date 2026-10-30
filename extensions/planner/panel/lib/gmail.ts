// Gmail beyond the panel's list, as Sunsama's Gmail integration has it: an email task's thread and the actions on it
// (Archive, Move to trash, Mark as unread), the import and completion automations (what is done to the email when it
// becomes a task and when the task is completed, or a prompt to choose), the account's labels, and the panel's labels
// and filters as one Gmail search.
import type { Command } from '../../src/domain/events.ts';
import { DEFAULT_MAIL_FILTER, gmailActionKey, mailQuery, threadIdOf, type GmailLabel, type MailFilter, type MailThread } from '../../src/domain/gmail.ts';
import type { GmailAction, PlannerState, Subtask, Task, TaskSourceRef } from '../../src/domain/types.ts';
import { mergedDone, mergedImports, subtasksChangedIn, wasMerged } from '../../src/domain/merge.ts';
import type { Origin, PlannerClient } from './client.ts';
import type { GoogleStore } from './google.ts';

/** An email the automations act on: its account, its thread, and what it is called. */
export interface GmailMail {
  account: string;
  thread: string;
  subject: string;
}

/**
 * The question after an email becomes a task, or its task is completed, when the settings ask ("Show prompt"): about
 * the task's own email and the emails merged into it, once for all of them (`subject` names the first, and how many
 * more).
 */
export interface GmailPrompt {
  when: 'import' | 'complete';
  taskId: string;
  mails: GmailMail[];
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
export const mailOfSource = (source: TaskSourceRef | null | undefined): GmailMail | null => {
  if (source?.kind !== 'email' || !source.account) return null;
  const thread = threadIdOf(source);
  return thread ? { account: source.account, thread, subject: source.title ?? 'the email' } : null;
};

/** An email task's account and thread, when it has both. */
export const mailOf = (task: Pick<Task, 'source'> | undefined): GmailMail | null => mailOfSource(task?.source);

/**
 * The emails completing a task acts on: its own, and the emails merged into it that were not checked off on their own
 * (checking one off ran its completion automations, or the question about them, then), as Sunsama keeps merged items
 * integrated: completing the task is checking off the ones still open.
 */
export const mailsCompletedWith = (task: Pick<Task, 'source' | 'subtasks'> | undefined): GmailMail[] => [
  ...(mailOf(task) ? [mailOf(task)!] : []),
  ...(task?.subtasks ?? []).flatMap((subtask) => (subtask.done ? [] : (mailOfSource(subtask.source) ?? []))),
];

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
    const verb = prompt.when === 'import' ? 'Importing' : 'Completing';
    void Promise.all(prompt.mails.map((mail) => this.act(mail.account, mail.thread, actions, verb))).then((done) => done.every(Boolean) && this.client.notify(`Gmail: done for "${prompt.subject}"`));
  }

  /**
   * The automations, after the user's own changes in this window: an email that became a task, an email task
   * completed; and, as Sunsama keeps merged items integrated, an email merged straight into a task, checked off there,
   * or completed with the task it is merged into (`mailsCompletedWith`). Reopening a task does nothing in Gmail, as
   * unchecking an email does not (Sunsama's Gmail automations are for importing and completing).
   */
  private afterCommit(commands: readonly Command[], before: PlannerState, after: PlannerState, origin: Origin): void {
    // Only the surfaces with room for the question act; the Work Status frame and the background never do.
    if (origin !== 'user' || this.surface === 'status' || this.surface === 'background') return;
    const made = commands.flatMap((command) => (command.type === 'task.created' && command.task.source ? [command.task.source] : []));
    const seen = new Set<string>();
    for (const command of commands) {
      // Once a task, for all of a batch's changes to its subtasks.
      const subtasksOf = subtasksChangedIn(command);
      if (subtasksOf) {
        if (seen.has(subtasksOf)) continue;
        seen.add(subtasksOf);
        const mails = (subtasks: readonly Subtask[]) => subtasks.flatMap((subtask) => mailOfSource(subtask.source) ?? []);
        this.automate('import', subtasksOf, mails(mergedImports(before, after, subtasksOf, made)), after);
        this.automate('complete', subtasksOf, mails(mergedDone(before.tasks[subtasksOf], after.tasks[subtasksOf])), after);
        continue;
      }
      const when = command.type === 'task.created' ? 'import' : command.type === 'task.completed' ? 'complete' : null;
      if (!when) continue;
      const taskId = command.type === 'task.created' ? command.task.id : command.type === 'task.completed' ? command.taskId : '';
      // An email task made again (planned anew after a delete) is an import; one that existed before is not, nor one
      // given back by Convert to task (its email was imported when it was merged).
      if (when === 'import' && before.tasks[taskId] && !before.tasks[taskId]!.deletedAt) continue;
      if (command.type === 'task.created' && command.task.source && wasMerged(before, command.task.source)) continue;
      const task = after.tasks[taskId];
      this.automate(when, taskId, when === 'complete' ? mailsCompletedWith(task) : mailOf(task) ? [mailOf(task)!] : [], after);
    }
  }

  /**
   * What the settings say to do to emails in Gmail when they are imported or their task completed: ask (once, about
   * all of them), or do it to each.
   */
  private automate(when: 'import' | 'complete', taskId: string, found: readonly GmailMail[], after: PlannerState): void {
    const mails = [...new Map(found.map((mail) => [`${mail.account}\n${mail.thread}`, mail])).values()];
    if (!mails.length) return;
    const settings = after.settings;
    const configured = when === 'import' ? settings.gmailOnImport : settings.gmailOnComplete;
    const ask = when === 'import' ? settings.gmailImportPrompt : settings.gmailCompletePrompt;
    if (ask) {
      const subject = mails.length === 1 ? mails[0]!.subject : `${mails[0]!.subject} and ${mails.length - 1} more`;
      this.set({ prompt: { when, taskId, mails, subject, actions: [...configured] } });
      return;
    }
    if (!configured.length) return;
    for (const account of new Set(mails.map((mail) => mail.account))) {
      if (!this.allowed(account)) {
        this.client.notify(`Gmail's ${when === 'import' ? 'import' : 'completion'} automations need Gmail actions for ${account}: allow them in Settings → Google`);
        continue;
      }
      for (const mail of mails.filter((item) => item.account === account)) void this.act(mail.account, mail.thread, configured, when === 'import' ? 'Importing' : 'Completing');
    }
  }
}

/** Actions without repeats, in the order they were picked. */
export const uniqueActions = (actions: readonly GmailAction[]): GmailAction[] => [...new Map(actions.map((action) => [gmailActionKey(action), action])).values()];
