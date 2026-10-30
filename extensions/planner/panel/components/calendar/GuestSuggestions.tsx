// Sunsama's Google Contacts integration in the event editor: as a guest is typed, the people of the event's Google
// account (its contacts, and the people it emailed) whose name or address starts so, to pick from. An account that has
// not allowed Contacts offers to allow them.
import { useEffect, useState } from 'preact/hooks';
import { useGoogle, usePlanner } from '../../lib/context.ts';

export interface ContactSuggestions {
  listId: string;
  account: string | null;
  contacts: { name: string; email: string }[];
  allowed: boolean;
}

export const useContactSuggestions = (account: string | null, draft: string): ContactSuggestions => {
  const { client, google } = usePlanner();
  useGoogle();
  const allowed = account ? google.allows(account, 'contacts') : false;
  const [contacts, setContacts] = useState<{ name: string; email: string }[]>([]);
  const words = draft.split(/[\s,;]+/).at(-1)?.trim() ?? '';
  useEffect(() => {
    setContacts([]);
    if (!account || !allowed || words.length < 2 || words.includes('@') && /\.[a-z]{2,}$/i.test(words)) return;
    let live = true;
    const timer = setTimeout(() => {
      void client
        .call<{ contacts: { name: string; email: string }[] }>('GET', `/google/contacts?account=${encodeURIComponent(account)}&q=${encodeURIComponent(words)}`)
        .then((answer) => live && setContacts(answer.contacts))
        .catch(() => {});
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [account, allowed, words]);
  return { listId: 'ee-guest-contacts', account, contacts, allowed };
};

export const GuestSuggestions = ({ suggestions }: { suggestions: ContactSuggestions }) => {
  const { client, google } = usePlanner();
  const [asking, setAsking] = useState(false);
  const { account } = suggestions;
  return (
    <>
      <datalist id={suggestions.listId}>
        {suggestions.contacts.map((contact) => <option key={contact.email} value={contact.email}>{contact.name}</option>)}
      </datalist>
      {account && !suggestions.allowed && (
        <button
          class="link ee-contacts-allow"
          disabled={asking}
          title={`Search the contacts of ${account}, and the people it emailed, when adding guests`}
          onClick={() => {
            setAsking(true);
            void google.allow(account, 'contacts').catch((error) => client.notify(error instanceof Error ? error.message : String(error))).finally(() => setAsking(false));
          }}
        >
          Search Google Contacts
        </button>
      )}
    </>
  );
};
