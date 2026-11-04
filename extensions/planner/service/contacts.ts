// Sunsama's Google Contacts integration: an account's contacts, and the people it emailed (Google's "other
// contacts"), searched by name or address when invitees are added to an event. Google answers a search from a cache it
// fills on an empty search, so each account's first search is preceded by one.
import type { GoogleAccounts } from './google.ts';

const PEOPLE = 'https://people.googleapis.com/v1';
const enc = encodeURIComponent;

export interface Contact {
  name: string;
  email: string;
}

interface RawPerson {
  names?: { displayName?: string }[];
  emailAddresses?: { value?: string }[];
}

export class GoogleContacts {
  private readonly warmed = new Set<string>();

  constructor(private readonly accounts: Pick<GoogleAccounts, 'request'>) {}

  /** Up to ten people of the account whose name or address starts with the words: contacts first, then other contacts. */
  async search(account: string, query: string): Promise<Contact[]> {
    const read = (path: string, words: string) =>
      this.accounts.request<{ results?: { person?: RawPerson }[] }>(account, 'GET', `${PEOPLE}/${path}?query=${enc(words)}&readMask=names,emailAddresses&pageSize=10`);
    if (!this.warmed.has(account)) {
      await Promise.allSettled([read('people:searchContacts', ''), read('otherContacts:search', '')]);
      this.warmed.add(account);
    }
    const answers = await Promise.all([read('people:searchContacts', query), read('otherContacts:search', query)]);
    const found = new Map<string, Contact>();
    for (const answer of answers) {
      for (const result of answer?.results ?? []) {
        const name = result.person?.names?.[0]?.displayName?.trim() ?? '';
        for (const address of result.person?.emailAddresses ?? []) {
          const email = address.value?.trim();
          if (email && !found.has(email.toLowerCase())) found.set(email.toLowerCase(), { name: name || email, email });
        }
      }
    }
    return [...found.values()].slice(0, 10);
  }
}
