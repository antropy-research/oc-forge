// The Google store's sources (one of its parts, store.ts): what the sources panel lists to plan, as Sunsama's Google
// Tasks and Gmail panels do (one task list's open tasks; a Gmail search, page by page), each planned at a place in
// the plan, picked there or dropped there; and Gmail's "Add to Tasks".
import type { EventBody, NewTask } from '../../../src/domain/core/events.ts';
import { newId } from '../../../src/domain/core/ids.ts';
import { edgePosition } from '../../../src/domain/core/selectors.ts';
import type { Placement, PlannerState, Task } from '../../../src/domain/core/types.ts';
import { messageOf } from '../../../src/domain/core/values.ts';
import { isGoogleTaskItem, isMailItem, taskForGoogleTask, taskForMail, taskFromGoogleTask, taskFromMail, type GoogleTaskItem, type GoogleTaskList, type MailItem } from '../../../src/domain/google/google.ts';
import { keptFor } from '../../../src/domain/google/taskKept.ts';
import { GOOGLE_DRAG_TYPE } from '../core/context.ts';
import type { GoogleStore } from './store.ts';

/** What a Google task or message carries while it is dragged (`importDropped` plans it where it is dropped). */
export type GoogleDrag = { kind: 'gtask'; item: GoogleTaskItem } | { kind: 'mail'; item: MailItem };

/** A Google task or message dragged: onto the calendar or a day, it is planned there. */
export const dragGoogle = (event: DragEvent, drag: GoogleDrag): void => {
  event.dataTransfer?.setData(GOOGLE_DRAG_TYPE, JSON.stringify(drag));
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove';
};

/** Commands that plan an item at `placement`: move its open task (`existing`) there, or create one (`make`). */
const planAt = (state: PlannerState, placement: Placement, position: number | undefined, existing: Task | null, make: (id: string, at: number) => NewTask): { bodies: EventBody[]; taskId: string } => {
  const at = position ?? edgePosition(state, placement, 'bottom');
  if (existing && !existing.completedAt) return { bodies: [{ type: 'task.moved', taskId: existing.id, placement, position: at }], taskId: existing.id };
  const id = newId();
  return { bodies: [{ type: 'task.created', task: make(id, at) }], taskId: id };
};

export const sourceMethods = {
  async loadLists(): Promise<void> {
    try {
      const answer = await this.client.call<{ lists: GoogleTaskList[]; errors: { account: string; message: string }[] }>('GET', '/google/tasklists');
      const current = this.view.list;
      const keep = current && answer.lists.some((list) => list.account === current.account && list.id === current.id);
      const first = answer.lists[0];
      this.set({ lists: answer.lists, list: keep ? current : first ? { account: first.account, id: first.id } : null, tasksError: answer.errors[0] ? `${answer.errors[0].account}: ${answer.errors[0].message}` : null });
      if (this.view.list) await this.refreshTasks();
    } catch (error) {
      this.set({ tasksError: messageOf(error) });
    }
  },

  selectList(account: string, id: string): void {
    this.set({ list: { account, id }, tasks: [] });
    void this.refreshTasks();
  },

  async refreshTasks(): Promise<void> {
    const list = this.view.list;
    if (!list) return;
    const seq = ++this.tasksSeq;
    this.set({ tasksLoading: true, tasksError: null });
    try {
      const answer = await this.client.call<{ tasks: GoogleTaskItem[] }>('GET', `/google/tasks?account=${encodeURIComponent(list.account)}&list=${encodeURIComponent(list.id)}`);
      if (seq !== this.tasksSeq) return;
      // Another list may have been chosen meanwhile.
      this.set(this.view.list === list ? { tasks: answer.tasks, tasksLoading: false } : { tasksLoading: false });
    } catch (error) {
      if (seq === this.tasksSeq) this.set({ tasksLoading: false, tasksError: messageOf(error) });
    }
  },

  /** Commands that plan a Google task at `placement`: move its open task there, or create one. */
  importTask(item: GoogleTaskItem, placement: Placement, position?: number): { bodies: EventBody[]; taskId: string } {
    const state = this.client.getView().state;
    return planAt(state, placement, position, taskForGoogleTask(state, item), (id, at) => taskFromGoogleTask(item, id, placement, at, keptFor(state, item)?.duration));
  },

  planTask(item: GoogleTaskItem, placement: Placement): Promise<void> {
    return this.client.dispatch(this.importTask(item, placement).bodies, { undo: `Planned "${item.title}"` });
  },

  setMailAccount(account: string): void {
    this.set({ mailAccount: account, mail: [], mailNext: null });
    void this.searchMail();
  },

  /** A Gmail search's first page (`asked`, else the current one's); `more` reads the next page of the current one and adds it. */
  async searchMail(asked?: string, more = false): Promise<void> {
    const query = asked ?? this.view.mailQuery;
    const account = this.view.mailAccount;
    this.set({ mailQuery: query });
    if (!account) return;
    const pageToken = more ? this.view.mailNext : null;
    if (more && !pageToken) return;
    // Another search, or Refresh, while this one (or its Load more) is on its way: the newest one's answer stands.
    const seq = ++this.mailSeq;
    this.set({ mailLoading: true, mailError: null });
    try {
      const answer = await this.client.call<{ messages: MailItem[]; nextPageToken?: string | null }>('GET', `/google/mail?account=${encodeURIComponent(account)}&q=${encodeURIComponent(query)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
      if (seq !== this.mailSeq) return;
      // Another account since, not searched yet: the panel searches it once nothing is loading.
      if (this.view.mailAccount !== account) return this.set({ mailLoading: false });
      const mail = more ? [...this.view.mail, ...answer.messages.filter((item) => !this.view.mail.some((known) => known.id === item.id))] : answer.messages;
      this.set({ mail, mailNext: answer.nextPageToken ?? null, mailLoading: false });
    } catch (error) {
      if (seq === this.mailSeq) this.set({ mailLoading: false, mailError: this.view.mailAccount === account ? messageOf(error) : null });
    }
  },

  /** Commands that plan a message at `placement`: move its open task there, or create one. */
  importMail(item: MailItem, placement: Placement, position?: number): { bodies: EventBody[]; taskId: string } {
    const state = this.client.getView().state;
    return planAt(state, placement, position, taskForMail(state, item), (id, at) => taskFromMail(item, id, placement, at));
  },

  planMail(item: MailItem, placement: Placement): Promise<void> {
    return this.client.dispatch(this.importMail(item, placement).bodies, { undo: `Planned "${item.subject}"` });
  },

  /** A dropped Google task or message, as commands that plan it; null when the payload is not one. */
  importDropped(raw: string, placement: Placement, position?: number): { bodies: EventBody[]; taskId: string; label: string } | null {
    let drag: unknown = null;
    try {
      drag = JSON.parse(raw);
    } catch {
      return null;
    }
    const value = drag as { kind?: unknown; item?: unknown } | null;
    if (value?.kind === 'gtask' && isGoogleTaskItem(value.item)) return { ...this.importTask(value.item, placement, position), label: `Planned "${value.item.title}"` };
    if (value?.kind === 'mail' && isMailItem(value.item)) return { ...this.importMail(value.item, placement, position), label: `Planned "${value.item.subject}"` };
    return null;
  },

  /**
   * Gmail's "Add to Tasks": a task in the account's default list titled as the message, as Gmail adds one. Google's
   * link back to the email is Gmail's own (its API lets no other app set one), so the message's address goes in
   * the task's details.
   */
  async addMailToTasks(item: MailItem): Promise<GoogleTaskItem> {
    const lists = this.view.lists.filter((list) => list.account === item.account);
    const list = lists.find((one) => one.isDefault) ?? lists[0];
    if (!list) throw new Error(`${item.account} has no task list (connect it with Tasks in Settings → Google)`);
    return this.addListTask(item.account, list.id, { title: item.subject.slice(0, 1024), notes: `From Gmail: ${item.url}` });
  },
} satisfies ThisType<GoogleStore>;
