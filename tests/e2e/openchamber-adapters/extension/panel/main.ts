// One page for the test extension's panel, its entries' own panel and its
// full page. It shows what the host told it and drives every oc-forge API, so
// the end-to-end check can read results off the frame.
import { connectHost, type HostReadyContext } from '@openchamber/sdk';
import { connectOcForge } from '../../../../../adapters/openchamber/client/index.ts';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const log = (line: string) => {
  $('log').textContent = `${new Date().toISOString().slice(11, 23)} ${line}\n${$('log').textContent ?? ''}`;
};
$('loaded').textContent = String(Date.now());

const host = connectHost();
let session: string | null = null;
const applyTheme = (context: HostReadyContext) => {
  const style = document.documentElement.style;
  style.setProperty('--bg', context.theme.tokens.background);
  style.setProperty('--fg', context.theme.tokens.foreground);
  style.setProperty('--border', context.theme.tokens.border);
  style.setProperty('--primary', context.theme.tokens.primary);
  style.setProperty('--font', context.theme.tokens.font);
  style.setProperty('--mono', context.theme.tokens.mono);
  session = context.session?.id ?? null;
};
host.onReady(applyTheme);
host.onSession((snapshot) => { session = snapshot?.id ?? null; });

const start = async () => {
const forge = await connectOcForge();
if (!forge) {
  $('status').textContent = 'stock OpenChamber: no oc-forge APIs';
} else {
  const { hello } = forge;
  $('status').textContent = `oc-forge v${hello.version}: ${hello.features.join(', ')}`;
  $('surface').textContent = `(${hello.surface}${forge.rail.own() ? ', own panel' : ''})`;
  document.body.dataset.surface = hello.surface;

  const showEntry = (entry: string | null) => { $('entry').textContent = entry ?? '—'; };
  showEntry(forge.rail.entry());
  forge.rail.onEntry((entry) => { showEntry(entry); log(`rail-entry ${entry}`); });
  $('report-beta').onclick = () => {
    void forge.rail.setActive('beta').then(() => { showEntry('beta'); log('reported beta'); }, (error: Error) => log(`report failed: ${error.message}`));
  };

  const showTab = (id: string | null) => { $('tab').textContent = id ?? '—'; };
  showTab(hello.tabs.shown ? hello.tabs.active : null);
  forge.tabs.onActivate((id) => { showTab(id); log(`tab-activated ${id}`); });
  forge.tabs.onClose((id) => log(`tab-closed ${id}`));
  forge.tabs.onChange((state) => { if (!state.shown) showTab(null); });
  const tabCall = (label: string, call: () => Promise<void>) => () => {
    void call().then(() => log(label), (error: Error) => log(`${label} failed: ${error.message}`));
  };
  $('open-a').onclick = tabCall('opened a', () => forge.tabs.open({ id: 'a', title: 'Tab A', icon: 'file-code' }, { activate: true }));
  $('open-b').onclick = tabCall('opened b', () => forge.tabs.open({ id: 'b', title: 'Tab B', dirty: true }, { activate: true }));
  $('close-a').onclick = tabCall('closed a', () => forge.tabs.close('a'));

  // Every press OpenChamber binds to navigation goes to it; the rest stays here.
  forge.keys.forwardHostShortcuts({
    onForward: (action, outcome) => {
      void outcome.then(
        () => { $('key-result').textContent = `forwarded ${action}`; },
        (error: Error) => { $('key-result').textContent = `refused: ${error.message}`; },
      );
    },
  });
  $('keys').addEventListener('keydown', (event) => {
    // A chord OpenChamber does not let frames forward, asked for anyway: refused.
    if ((event.ctrlKey || event.metaKey) && /^[a-z]$/.test(event.key)) {
      event.preventDefault();
      void forge.keys.forward(event).then(
        (action) => { $('key-result').textContent = `forwarded ${action}`; },
        (error: Error) => { $('key-result').textContent = `refused: ${error.message}`; },
      );
    }
  });
  $('late-key').onclick = () => {
    // Long after the click: no user activation left, so the host must refuse.
    setTimeout(() => {
      void forge.keys.forward({ key: '1', code: 'Digit1', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }).then(
        (action) => { $('key-result').textContent = `late: forwarded ${action}`; },
        (error: Error) => { $('key-result').textContent = `late: refused: ${error.message}`; },
      );
    }, 7000);
  };

  const showRoute = (route: string | null) => { $('route').textContent = route ?? '—'; };
  showRoute(forge.links.route());
  forge.links.onRoute((route) => { showRoute(route); log(`route ${route}`); });
  const pageLink = $('page-link') as HTMLAnchorElement;
  pageLink.href = forge.links.pageUrl('/item/42') ?? '#';
  const sessionLink = $('session-link') as HTMLAnchorElement;
  const linkSession = () => { sessionLink.href = session ? forge.links.sessionUrl(session) ?? '#' : '#'; };
  linkSession();
  host.onSession(() => linkSession());
  // A plain click stays in this window: the page handles it. Modified clicks open a tab.
  pageLink.addEventListener('click', (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    void forge.links.setRoute('/item/42', { push: true }).then(() => showRoute('/item/42'));
  });
  sessionLink.addEventListener('click', (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0 || !session) return;
    event.preventDefault();
    void host.openSession(session);
  });
  $('set-route').onclick = () => {
    void forge.links.setRoute('/item/7', { push: true }).then(() => { showRoute('/item/7'); log('route set /item/7'); }, (error: Error) => log(`set route failed: ${error.message}`));
  };
}
};

void start();
