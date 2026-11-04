// Gmail beyond reading messages, for Sunsama's actions on an email task and its import and completion automations:
// the account's labels, a thread with its messages' text (the conversation the task shows), and the actions done to
// a thread (labels added and removed in one change, then the trash). Acting needs the account's "Gmail actions"
// (gmail.modify, which never deletes outright); reading needs Gmail's read-only access, as before.
import type { GoogleAccounts } from './google.ts';
import { GoogleError } from './google.ts';
import { gmailChanges, messageText, type GmailLabel, type MailThread, type RawPart, type ThreadMessage } from '../src/domain/gmail.ts';
import type { GmailAction } from '../src/domain/types.ts';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const enc = encodeURIComponent;

/** Gmail's own labels the panel lists, by the names Gmail shows; its categories and chats are left out. */
const SYSTEM_NAMES: Record<string, string> = { INBOX: 'Inbox', STARRED: 'Starred', IMPORTANT: 'Important', UNREAD: 'Unread', SENT: 'Sent', DRAFT: 'Drafts', SPAM: 'Spam', TRASH: 'Trash' };

interface RawLabel {
  id?: string;
  name?: string;
  type?: string;
}

interface RawThreadMessage {
  id?: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: RawPart & { headers?: { name?: string; value?: string }[] };
}

export class GmailActions {
  constructor(private readonly accounts: GoogleAccounts) {}

  /** The account's labels: Gmail's own the panel lists (Inbox, Starred…), then the user's, by name. */
  async labels(account: string): Promise<GmailLabel[]> {
    const answer = await this.accounts.request<{ labels?: RawLabel[] }>(account, 'GET', `${GMAIL}/labels`);
    const all = (answer?.labels ?? []).flatMap((label): GmailLabel[] => {
      if (!label.id || !label.name) return [];
      if (label.type === 'system') return SYSTEM_NAMES[label.id] ? [{ id: label.id, name: SYSTEM_NAMES[label.id]!, type: 'system' }] : [];
      return [{ id: label.id, name: label.name, type: 'user' }];
    });
    const order = Object.keys(SYSTEM_NAMES);
    return [
      ...all.filter((label) => label.type === 'system').sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)),
      ...all.filter((label) => label.type === 'user').sort((a, b) => a.name.localeCompare(b.name)),
    ];
  }

  /** A thread's messages, oldest first, with their text, and the labels it has now. */
  async thread(account: string, threadId: string): Promise<MailThread | null> {
    let raw: { messages?: RawThreadMessage[] } | null;
    try {
      raw = await this.accounts.request<{ messages?: RawThreadMessage[] }>(account, 'GET', `${GMAIL}/threads/${enc(threadId)}?format=full`);
    } catch (error) {
      if (error instanceof GoogleError && error.status === 404) return null;
      throw error;
    }
    if (!raw) return null;
    const messages = (raw.messages ?? []).flatMap((message): ThreadMessage[] => {
      if (!message.id) return [];
      const header = (name: string) => message.payload?.headers?.find((item) => item.name?.toLowerCase() === name)?.value ?? '';
      const internal = Number(message.internalDate);
      const date = Number.isFinite(internal) && internal > 0 ? new Date(internal).toISOString() : header('date') ? new Date(header('date')).toISOString() : '';
      return [{ id: message.id, from: header('from'), to: header('to'), date, subject: header('subject'), snippet: message.snippet ?? '', text: messageText(message.payload).slice(0, 20_000), unread: (message.labelIds ?? []).includes('UNREAD') }];
    });
    const labelIds = [...new Set((raw.messages ?? []).flatMap((message) => message.labelIds ?? []))];
    return { id: threadId, account, messages, labelIds };
  }

  /**
   * Do the actions to a thread, as Gmail does them to a conversation: the labels in one change, then the trash.
   * A label the account doesn't have is refused before anything changes (Sunsama: the label is made in Gmail first).
   */
  async act(account: string, threadId: string, actions: readonly GmailAction[]): Promise<{ labelIds: string[] }> {
    const needsLabels = actions.some((action) => action.kind === 'addLabel' || action.kind === 'removeLabel');
    const labels = needsLabels ? await this.labels(account).then((known) => known.filter((label) => label.type === 'user')) : [];
    const changes = gmailChanges(actions, labels);
    if (changes.missing.length) throw new GoogleError(400, `Gmail has no label ${changes.missing.map((name) => `"${name}"`).join(', ')} in ${account}: make it in Gmail first`);
    let labelIds: string[] = [];
    if (changes.add.length || changes.remove.length) {
      const answer = await this.accounts.request<{ messages?: { labelIds?: string[] }[] }>(account, 'POST', `${GMAIL}/threads/${enc(threadId)}/modify`, { addLabelIds: changes.add, removeLabelIds: changes.remove });
      labelIds = [...new Set((answer?.messages ?? []).flatMap((message) => message.labelIds ?? []))];
    }
    if (changes.trash) {
      const answer = await this.accounts.request<{ messages?: { labelIds?: string[] }[] }>(account, 'POST', `${GMAIL}/threads/${enc(threadId)}/trash`);
      labelIds = [...new Set((answer?.messages ?? []).flatMap((message) => message.labelIds ?? []))];
    }
    return { labelIds };
  }
}
