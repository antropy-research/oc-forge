// The host's side of the service socket (service-socket.ts): one per window,
// on the web runtime only, where the page's own origin carries the session
// cookie with the upgrade (the forwarded requests authenticate with it; the
// upgrade also takes the URL token the resolver adds). With a relay, a remote
// runtime or a realtime proxy, and whenever the socket is unavailable,
// requests go over fetch as in the release.
import { getActiveRelayTunnel } from '@/lib/relay/runtime-tunnel';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';

import { createOcForgeServiceSocket } from './service-socket.ts';

const PATH = '/api/oc-forge/service-socket';
/** `off` in the window's localStorage keeps service requests on HTTP (tests that answer them in place set it). */
export const OC_FORGE_SERVICE_SOCKET_SWITCH = 'oc-forge:service-socket';

const switchedOff = (): boolean => {
  try {
    return window.localStorage.getItem(OC_FORGE_SERVICE_SOCKET_SWITCH) === 'off';
  } catch {
    return false;
  }
};

const openSocket = (): WebSocket | null => {
  if (typeof window === 'undefined' || typeof WebSocket === 'undefined' || getActiveRelayTunnel() || switchedOff()) return null;
  const url = new URL(getRuntimeUrlResolver().websocket(PATH), window.location.href);
  if (url.host !== window.location.host || url.pathname !== PATH || [...url.searchParams.keys()].some((key) => key !== 'oc_url_token')) return null;
  return new WebSocket(url.toString());
};

const transport = createOcForgeServiceSocket(openSocket);

/** A guest service request over the window's socket, as the response its fetch would have been; null: use fetch. */
export const ocForgeServiceRequest = async (guestId: string, body: unknown): Promise<Response | null> => {
  const answer = await transport.request(guestId, body);
  if (!answer) return null;
  const status = answer.status >= 200 && answer.status <= 599 ? answer.status : 502;
  return new Response(answer.text, { status, headers: { 'content-type': 'application/json' } });
};
