// Gmail as Sunsama's integration has it (help.sunsama.com/docs/integrations/gmail), beyond reading messages: the
// actions on an email task (Open in Gmail, Archive, Move to trash, Mark as unread), the import and completion
// automations (what is done to the email when it becomes a task, and when the task is completed, or a prompt to
// choose), the panel's labels (one at a time, more with Cmd/Ctrl) and filters (archived, spam and trash, already
// imported), and the email client a message opens in (Gmail, or Superhuman).
import { GMAIL_ACTIONS, type GmailAction, type GmailActionKind, type Settings, type TaskSourceRef } from './types.ts';

/** Sunsama's names for them. */
export const GMAIL_ACTION_LABELS: Record<GmailActionKind, string> = {
  markRead: 'Mark as read',
  markUnread: 'Mark as unread',
  archive: 'Archive',
  trash: 'Move to trash',
  star: 'Star',
  unstar: 'Unstar',
  addLabel: 'Apply a label',
  removeLabel: 'Remove a label',
};

/** An action as a list says it: "Apply a label: In progress". */
export const gmailActionText = (action: GmailAction): string => (action.label ? `${GMAIL_ACTION_LABELS[action.kind]}: ${action.label}` : GMAIL_ACTION_LABELS[action.kind]);

/** The same action twice is one (a label's, by its name). */
export const gmailActionKey = (action: GmailAction): string => `${action.kind}${action.label ? `:${action.label.toLowerCase()}` : ''}`;

/** Gmail's own labels, by the names Gmail shows (and that automations name). */
export const SYSTEM_LABELS: Record<string, string> = { inbox: 'INBOX', starred: 'STARRED', important: 'IMPORTANT', unread: 'UNREAD', spam: 'SPAM', trash: 'TRASH', sent: 'SENT', drafts: 'DRAFT' };

export interface GmailLabel {
  id: string;
  name: string;
  type: 'system' | 'user';
}

/**
 * What the actions change on a thread: the labels added and removed (archive takes Inbox off, read takes Unread off,
 * a label by its id), and whether it goes to the trash (last). A label the account has no label for is named.
 */
export const gmailChanges = (actions: readonly GmailAction[], labels: readonly GmailLabel[]): { add: string[]; remove: string[]; trash: boolean; missing: string[] } => {
  const add = new Set<string>();
  const remove = new Set<string>();
  const missing: string[] = [];
  let trash = false;
  const idOf = (name: string): string | null => SYSTEM_LABELS[name.trim().toLowerCase()] ?? labels.find((label) => label.name.toLowerCase() === name.trim().toLowerCase())?.id ?? null;
  const put = (into: Set<string>, from: Set<string>, id: string) => {
    from.delete(id);
    into.add(id);
  };
  for (const action of actions) {
    switch (action.kind) {
      case 'markRead': put(remove, add, 'UNREAD'); break;
      case 'markUnread': put(add, remove, 'UNREAD'); break;
      case 'archive': put(remove, add, 'INBOX'); break;
      case 'star': put(add, remove, 'STARRED'); break;
      case 'unstar': put(remove, add, 'STARRED'); break;
      case 'trash': trash = true; break;
      case 'addLabel':
      case 'removeLabel': {
        const id = action.label ? idOf(action.label) : null;
        if (!id) missing.push(action.label ?? '');
        else if (action.kind === 'addLabel') put(add, remove, id);
        else put(remove, add, id);
        break;
      }
    }
  }
  return { add: [...add], remove: [...remove], trash, missing };
};

export const isGmailActionKind = (value: unknown): value is GmailActionKind => (GMAIL_ACTIONS as readonly unknown[]).includes(value);

/** The panel's view of Gmail: the labels shown (all must match, as Sunsama's), the filters, and words to search for. */
export interface MailFilter {
  /** Label names; none means the Inbox. */
  labels: string[];
  /** Show archived emails (not in the Inbox), spam and trash, and the ones already in the plan. */
  archived: boolean;
  spamTrash: boolean;
  imported: boolean;
  words: string;
}

/** Sunsama's start: the Inbox, without archived, spam, trash or imported emails. */
export const DEFAULT_MAIL_FILTER: MailFilter = { labels: ['Inbox'], archived: false, spamTrash: false, imported: false, words: '' };

/** A label as Gmail's search names it: `label:in-progress` (lower case, a dash for spaces and slashes). */
const searchLabel = (name: string): string => {
  const system = SYSTEM_LABELS[name.trim().toLowerCase()];
  if (system === 'INBOX') return 'in:inbox';
  if (system === 'STARRED') return 'is:starred';
  if (system === 'IMPORTANT') return 'is:important';
  if (system === 'UNREAD') return 'is:unread';
  if (system === 'SPAM') return 'in:spam';
  if (system === 'TRASH') return 'in:trash';
  if (system === 'SENT') return 'in:sent';
  if (system === 'DRAFT') return 'in:drafts';
  return `label:${name.trim().toLowerCase().replace(/[\s/]+/g, '-')}`;
};

/**
 * The filter as one Gmail search: every label shown (an email must have them all); archived ones left out unless
 * shown (an archived email is one out of the Inbox); spam and trash in only when shown (Gmail leaves them out).
 */
export const mailQuery = (filter: MailFilter): string => {
  const labels = filter.labels.length ? filter.labels : ['Inbox'];
  const terms = labels.map(searchLabel);
  if (!filter.archived && !terms.includes('in:inbox')) terms.push('in:inbox');
  if (filter.spamTrash) terms.push('in:anywhere');
  const words = filter.words.replace(/\s+/g, ' ').trim();
  return [...terms, ...(words ? [words] : [])].join(' ');
};

/** A click on a label shows that one alone; with Cmd/Ctrl it is added to the ones shown (or taken off them). */
export const pickLabel = (shown: readonly string[], name: string, adding: boolean): string[] => {
  if (!adding) return [name];
  const has = shown.some((label) => label.toLowerCase() === name.toLowerCase());
  const next = has ? shown.filter((label) => label.toLowerCase() !== name.toLowerCase()) : [...shown, name];
  return next.length ? next : ['Inbox'];
};

/** The Gmail thread a linked email task's address names (`…#all/<thread>`). */
export const threadIdOf = (source: Pick<TaskSourceRef, 'url'>): string | null => /#[^/]+\/([0-9a-zA-Z_-]+)$/.exec(source.url)?.[1] ?? null;

/** Where an email opens: in Gmail (its address), or in Superhuman when that is the email client. */
export const emailUrl = (source: Pick<TaskSourceRef, 'url' | 'account'>, client: Settings['emailClient']): string => {
  const thread = threadIdOf(source);
  if (client === 'superhuman' && thread && source.account) return `https://mail.superhuman.com/${encodeURIComponent(source.account)}/thread/${thread}`;
  return source.url;
};

/** Where a linked task's item opens (an email in the user's email client). */
export const sourceUrl = (source: TaskSourceRef, settings: Pick<Settings, 'emailClient'>): string => (source.kind === 'email' ? emailUrl(source, settings.emailClient) : source.url);

/** Plain text of a message part (Gmail's base64url), its text/plain alternative first, else its HTML without tags. */
export interface RawPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: RawPart[];
}

const decode = (data: string): string => {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

const htmlText = (html: string): string =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export const messageText = (part: RawPart | undefined): string => {
  if (!part) return '';
  const find = (node: RawPart, type: string): string | null => {
    if (node.mimeType === type && node.body?.data) return decode(node.body.data);
    for (const child of node.parts ?? []) {
      const found = find(child, type);
      if (found !== null) return found;
    }
    return null;
  };
  const plain = find(part, 'text/plain');
  if (plain !== null) return plain.replace(/\r\n/g, '\n').trim();
  const html = find(part, 'text/html');
  return html !== null ? htmlText(html) : '';
};

/** One message of a thread, as the task shows it (Sunsama embeds the thread and its conversation in the task). */
export interface ThreadMessage {
  id: string;
  from: string;
  to: string;
  date: string;
  subject: string;
  snippet: string;
  text: string;
  unread: boolean;
}

/** A thread as the task shows it, and what Gmail has it in now (Inbox, Unread, Starred, Trash…). */
export interface MailThread {
  id: string;
  account: string;
  messages: ThreadMessage[];
  labelIds: string[];
}
