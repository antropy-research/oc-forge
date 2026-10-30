// Settings → Gmail, as Sunsama's Gmail settings: the import and completion automations (what is done to an email in
// Gmail when it becomes a task and when that task is completed, several at once, or "Show prompt" to choose email by
// email), the custom email client (Gmail or Superhuman), and each account's permission to act on email.
import { useEffect, useState } from 'preact/hooks';
import { GMAIL_ACTION_LABELS, gmailActionKey, gmailActionText, type GmailLabel } from '../../src/domain/gmail.ts';
import type { GmailAction, Settings as PlannerSettings } from '../../src/domain/types.ts';
import { useGmail, useGoogle, usePlanner, useView } from '../lib/context.ts';
import { uniqueActions } from '../lib/gmail.ts';

const SIMPLE = ['markRead', 'markUnread', 'archive', 'trash', 'star', 'unstar'] as const;

const AutomationEditor = ({ title, hint, actions, prompt, labels, onActions, onPrompt }: {
  title: string;
  hint: string;
  actions: GmailAction[];
  prompt: boolean;
  labels: string[];
  onActions: (next: GmailAction[]) => void;
  onPrompt: (next: boolean) => void;
}) => {
  const [label, setLabel] = useState('');
  const has = (action: GmailAction) => actions.some((item) => gmailActionKey(item) === gmailActionKey(action));
  const toggle = (action: GmailAction) => onActions(has(action) ? actions.filter((item) => gmailActionKey(item) !== gmailActionKey(action)) : uniqueActions([...actions, action]));
  const named = actions.filter((action) => action.label);
  const add = (kind: 'addLabel' | 'removeLabel') => {
    if (!label) return;
    onActions(uniqueActions([...actions, { kind, label }]));
    setLabel('');
  };
  return (
    <div class="gmail-automation" role="group" aria-label={title}>
      <h3>{title}</h3>
      <p class="hint">{hint}</p>
      <div class="gmail-automation-choices">
        {SIMPLE.map((kind) => (
          <label key={kind}>
            <input type="checkbox" checked={has({ kind })} onChange={() => toggle({ kind })} /> {GMAIL_ACTION_LABELS[kind]}
          </label>
        ))}
      </div>
      {named.length > 0 && (
        <ul class="gmail-automation-labels">
          {named.map((action) => (
            <li key={gmailActionKey(action)}>
              {gmailActionText(action)} <button class="link danger" aria-label={`Remove "${gmailActionText(action)}" from ${title}`} onClick={() => toggle(action)}>×</button>
            </li>
          ))}
        </ul>
      )}
      <div class="row">
        <select aria-label={`A label for ${title}`} value={label} onChange={(event) => setLabel(event.currentTarget.value)}>
          <option value="">A label…</option>
          {labels.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <button class="link" disabled={!label} onClick={() => add('addLabel')}>{GMAIL_ACTION_LABELS.addLabel}</button>
        <button class="link" disabled={!label} onClick={() => add('removeLabel')}>{GMAIL_ACTION_LABELS.removeLabel}</button>
      </div>
      <label>
        <input type="checkbox" checked={prompt} onChange={(event) => onPrompt(event.currentTarget.checked)} /> Show prompt
        <span class="hint"> (ask which to do, email by email)</span>
      </label>
    </div>
  );
};

export const GmailSettings = () => {
  const { client, google, gmail } = usePlanner();
  const view = useView();
  const gv = useGoogle();
  const mv = useGmail();
  const settings = view.state.settings;
  const accounts = gv.status ? google.accountsWith('mail') : [];
  const [allowing, setAllowing] = useState<string | null>(null);
  useEffect(() => {
    for (const account of accounts) void gmail.labels(account.email).catch(() => {});
  }, [accounts.map((account) => account.email).join()]);
  if (!accounts.length) return null;
  const update = (patch: Partial<PlannerSettings>) => void client.dispatch([{ type: 'settings.updated', patch }]);
  // Labels by name, across the accounts (each has its own ids); Gmail's Inbox, so removing it takes an email out of the Inbox.
  const labelNames = [...new Set(['Inbox', 'Starred', 'Important', ...accounts.flatMap((account) => (mv.labels[account.email] ?? []).filter((label: GmailLabel) => label.type === 'user').map((label) => label.name))])];
  const missing = accounts.filter((account) => !account.features.includes('mailActions'));
  return (
    <fieldset>
      <legend>Gmail</legend>
      <p class="hint">
        As in Sunsama: what happens to an email in Gmail when it becomes a task, and when that task is completed. Several can be picked, and a label must be made in Gmail first.
        An "Inbox Zero" set-up: on import, Mark as read and Remove a label: Inbox; on completion, Archive.
      </p>
      <AutomationEditor
        title="Import automations"
        hint="When an email becomes a task (dragged, planned or pasted)."
        actions={settings.gmailOnImport}
        prompt={settings.gmailImportPrompt}
        labels={labelNames}
        onActions={(next) => update({ gmailOnImport: next })}
        onPrompt={(next) => update({ gmailImportPrompt: next })}
      />
      <AutomationEditor
        title="Completion automations"
        hint="When the task of an email is completed."
        actions={settings.gmailOnComplete}
        prompt={settings.gmailCompletePrompt}
        labels={labelNames}
        onActions={(next) => update({ gmailOnComplete: next })}
        onPrompt={(next) => update({ gmailCompletePrompt: next })}
      />
      <label>
        Custom email client
        <select value={settings.emailClient} onChange={(event) => update({ emailClient: event.currentTarget.value as PlannerSettings['emailClient'] })}>
          <option value="gmail">Gmail</option>
          <option value="superhuman">Superhuman</option>
        </select>
      </label>
      {missing.length > 0 && (
        <div class="gmail-allow">
          <p class="hint">Archiving, trashing, marking and labelling need Gmail's permission to change email (never to delete it outright), account by account:</p>
          {missing.map((account) => (
            <div key={account.email} class="row">
              <span class="grow">{account.email}</span>
              <button class="link" disabled={allowing === account.email} onClick={() => { setAllowing(account.email); void google.allow(account.email, 'mailActions').finally(() => setAllowing(null)); }}>Allow Gmail actions</button>
            </div>
          ))}
        </div>
      )}
    </fieldset>
  );
};
