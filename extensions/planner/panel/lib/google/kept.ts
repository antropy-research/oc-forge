// The Google store's kept settings (one of its parts, store.ts): what the Planner keeps for a Google task beside
// Google's own fields, as Google Tasks' API has none of them for other apps (a time, a deadline, a repeat, a star,
// its advanced settings), set at once with no Google write; and what reaches Google from them through the service:
// Drive files to attach, and the meetings declined during a task.
import type { GoogleTaskKeptPatch } from '../../../src/domain/core/events.ts';
import type { DateKey } from '../../../src/domain/core/types.ts';
import type { GoogleTaskItem } from '../../../src/domain/google/google.ts';
import { declineCarriesOn, type DeclinedMeeting, type DriveFile } from '../../../src/domain/google/taskAdvanced.ts';
import { keptFor } from '../../../src/domain/google/taskKept.ts';
import { calendarUi } from '../calendar/calendarUi.ts';
import type { GoogleStore } from './store.ts';
import type { GoogleTaskRef } from './types.ts';

export const keptMethods = {
  /** What the Planner keeps for a Google task (a time, a deadline, a repeat, a star): set at once, with no Google write (Google Tasks has none of them for other apps). */
  setKept(item: GoogleTaskRef, patch: GoogleTaskKeptPatch): Promise<void> {
    return this.client.dispatch([{ type: 'gtask.kept', account: item.account, listId: item.listId, taskId: item.id, patch }]);
  },

  /** Google Tasks' star: on, or off. Kept in the Planner alone, so nothing goes to Google. */
  toggleStar(item: GoogleTaskRef): Promise<void> {
    return this.setKept(item, { starred: !keptFor(this.client.getView().state, item)?.starredAt });
  },

  /**
   * A timed Google task dragged on the grid: a new day is Google's date,
   * written first; a new time is kept here once Google has the day, so a day
   * Google refuses leaves the time as it was (the task keeps its time).
   */
  async moveTimedTask(item: GoogleTaskItem, date: DateKey, time: number): Promise<void> {
    if (item.due !== date) await this.setTaskDue(item, date);
    if (keptFor(this.client.getView().state, item)?.time !== time) await this.setKept(item, { time });
  },

  /** A page of the Drive files whose name has `text` (the latest when empty), to attach to a task, and the next page's token. */
  async searchDrive(account: string, text: string, pageToken?: string | null): Promise<{ files: DriveFile[]; next: string | null }> {
    const answer = await this.client.call<{ files: DriveFile[]; next?: string | null }>('GET', `/google/drive/files?account=${encodeURIComponent(account)}&q=${encodeURIComponent(text)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
    return { files: answer.files ?? [], next: answer.next ?? null };
  },

  /** The meetings the Planner declined for a task, and where its declining carries on (`more`; null when it is through). */
  async declinedFor(account: string, taskId: string): Promise<{ declined: DeclinedMeeting[]; more: string | null }> {
    const answer = await this.client.call<{ declined: DeclinedMeeting[]; more?: string | null }>('GET', `/google/tasks/declined?account=${encodeURIComponent(account)}&task=${encodeURIComponent(taskId)}`);
    return { declined: answer.declined ?? [], more: answer.more ?? null };
  },

  /**
   * "Automatically decline meetings" now, after a task's change; says what it declined, and, when the pass stopped at
   * one of its bounds, that the Planner carries on (the service's next pass does, a few seconds later).
   */
  declineSoon(): void {
    void this.client
      .call<{ declined: DeclinedMeeting[]; errors: string[]; more?: { account: string; from: string }[] }>('POST', '/google/tasks/decline')
      .then((answer) => {
        const declined = answer.declined ?? [];
        const more = answer.more?.[0] ? ` ${declineCarriesOn(answer.more[0].from, this.client.getView().state.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)}.` : '';
        if (declined.length) {
          calendarUi.refresh();
          const names = declined.slice(0, 3).map((meeting) => `"${meeting.summary}"`).join(', ');
          this.client.notify(`Declined ${declined.length === 1 ? 'a meeting' : `${declined.length} meetings`} during "${declined[0]!.task}": ${names}${declined.length > 3 ? ` and ${declined.length - 3} more` : ''}.${more}`);
        } else if (more) this.client.notify(more.trim());
        if (answer.errors?.length) this.client.notify(`Some meetings were not declined: ${answer.errors[0]}`);
      })
      .catch(() => {
        // The service declines them at its next pass.
      });
  },
} satisfies ThisType<GoogleStore>;
