// The Google store's accounts (one of its parts, store.ts): the OAuth client the service signs in with, a sign-in (the
// browser goes to Google and the service waits for its redirect, or takes the address pasted), one more feature
// asked for, an account removed, and what each account allowed.
import { messageOf } from '../../../src/domain/core/values.ts';
import type { GoogleStore } from './store.ts';
import type { GoogleAccountView, GoogleFeature, GoogleStatusView, SignInResult } from './types.ts';

const SIGN_IN_POLL_MS = 1500;
const SIGN_IN_MAX_MS = 10 * 60_000;

const stopSignIn = (google: GoogleStore): void => {
  if (google.signInTimer) clearTimeout(google.signInTimer);
  google.signInTimer = null;
};

const settleSignIn = async (google: GoogleStore, id: string, result: SignInResult): Promise<void> => {
  const current = google.view.signIn;
  if (!current || current.id !== id) return;
  google.set({ signIn: { ...current, result } });
  if (result.status === 'pending') return;
  stopSignIn(google);
  if (result.status === 'connected') {
    google.client.notify(`Connected ${result.email} to the Planner`);
    google.set({ signIn: null });
    await google.checkStatus();
    if (result.features.includes('calendar')) void google.loadCalendars();
  }
};

export const accountMethods = {
  accountsWith(feature: GoogleFeature): GoogleAccountView[] {
    return (this.view.status?.accounts ?? []).filter((account) => account.features.includes(feature));
  },

  /** Whether an account allowed a feature. */
  allows(account: string, feature: GoogleFeature): boolean {
    return Boolean(this.view.status?.accounts.find((item) => item.email === account)?.features.includes(feature));
  },

  /** A work or school account (Google Workspace): Google Calendar gives its tasks Do not disturb and declining meetings. */
  isWorkspace(account: string): boolean {
    return Boolean(this.view.status?.accounts.find((item) => item.email === account)?.workspace);
  },

  /**
   * Ask Google for one more feature of an account (Drive, to attach files), the way the Planner asks for the others:
   * a sign-in for what it has plus that one, which Google adds to what was allowed before.
   */
  allow(account: string, feature: GoogleFeature): Promise<void> {
    const current = this.view.status?.accounts.find((item) => item.email === account)?.features ?? [];
    return this.connect([...new Set([...current, feature])]);
  },

  async checkStatus(): Promise<void> {
    try {
      const status = await this.client.call<GoogleStatusView>('GET', '/google/status');
      this.set({ status, error: null });
      // An account the Planner has not seen yet gets its own calendar shown (loadCalendars), wherever the user is.
      const seen = this.client.getView().state.settings.googleCalendarsIntroduced ?? [];
      if (status.accounts.some((account) => account.features.includes('calendar') && !seen.includes(account.email))) void this.loadCalendars();
      const mailAccounts = status.accounts.filter((account) => account.features.includes('mail'));
      if (!mailAccounts.some((account) => account.email === this.view.mailAccount)) this.set({ mailAccount: mailAccounts[0]?.email ?? null, mail: [], mailNext: null });
      if (status.accounts.some((account) => account.features.includes('tasks'))) {
        await this.loadLists();
        void this.sync();
      } else this.set({ lists: [], list: null, tasks: [] });
    } catch (error) {
      this.set({ status: { client: null, accounts: [] }, error: messageOf(error) });
    }
  },

  async setClient(id: string, secret: string): Promise<void> {
    const status = await this.client.call<GoogleStatusView>('PUT', '/google/client', { id, secret });
    this.set({ status: { ...this.view.status, ...status } });
  },

  async clearClient(): Promise<void> {
    const status = await this.client.call<GoogleStatusView>('DELETE', '/google/client');
    this.set({ status, calendars: [], lists: [], list: null, tasks: [], mail: [], mailAccount: null });
    await this.forgetCalendars(() => true);
  },

  /** Start a sign-in: the service waits for Google's redirect; the browser goes to Google. */
  async connect(features: readonly GoogleFeature[]): Promise<void> {
    stopSignIn(this);
    const started = await this.client.call<{ id: string; authUrl: string; redirectUri: string }>('POST', '/google/connect', { features });
    this.set({ signIn: { ...started, result: { status: 'pending' } } });
    void this.host.openUrl(started.authUrl).catch(() => {
      // The address shows in Settings to open by hand.
    });
    const until = Date.now() + SIGN_IN_MAX_MS;
    const poll = async () => {
      const current = this.view.signIn;
      if (!current || current.id !== started.id) return;
      try {
        const result = await this.client.call<SignInResult>('GET', `/google/connect/${started.id}`);
        await settleSignIn(this, started.id, result);
        if (result.status !== 'pending') return;
      } catch {
        // A blip; ask again.
      }
      if (Date.now() < until) this.signInTimer = setTimeout(() => void poll(), SIGN_IN_POLL_MS);
    };
    this.signInTimer = setTimeout(() => void poll(), SIGN_IN_POLL_MS);
  },

  /** Finish the sign-in with the address the browser was sent to, when this machine's listener was out of its reach. */
  async finishSignIn(address: string): Promise<void> {
    const current = this.view.signIn;
    if (!current) return;
    const result = await this.client.call<SignInResult>('POST', `/google/connect/${current.id}/finish`, { url: address });
    await settleSignIn(this, current.id, result);
  },

  cancelSignIn(): void {
    stopSignIn(this);
    this.set({ signIn: null });
  },

  async removeAccount(email: string): Promise<void> {
    await this.client.call<{ removed: boolean }>('DELETE', `/google/accounts/${encodeURIComponent(email)}`);
    await this.forgetCalendars((account) => account === email);
    await this.checkStatus();
    this.set({ calendars: this.view.calendars.filter((calendar) => calendar.account !== email) });
  },
} satisfies ThisType<GoogleStore>;
