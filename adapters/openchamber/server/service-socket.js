// oc-forge: guest service requests over one WebSocket per window.
//
// Over plain HTTP/1.1 a browser keeps six connections per host for all of a
// site's tabs. Every guest service request was an HTTP request of its own, so
// an extension whose frames long-poll their service (VS Code's tunnels) held
// all six once two windows were open, and every other request of both windows
// waited. A browser pools WebSockets apart from those six. The host sends each
// service request here instead; this runs it as `POST /api/guests/:id/service/
// request` on the server's own address, with the window's cookie and host, so
// the route's own checks, limits and answers apply unchanged, and a long-poll
// waits here instead of in the browser.
//
// Messages are text: `<id> <guestId>\n<request JSON>` from the window, and
// `<id> <status>\n<the route's answer>` back, in any order.
import http from 'node:http';
import https from 'node:https';

import { WebSocketServer } from 'ws';

import { isOpaqueOriginRequest, isPasswordlessSocketOriginAllowed } from '../security/request-security.js';

export const OC_FORGE_SERVICE_SOCKET_PATH = '/api/oc-forge/service-socket';
// Above the route's own body limit (80 MB); answers are far smaller (a service answers 8 MB at most).
const MESSAGE_MAX_BYTES = 96 * 1024 * 1024;
const GUEST_ID = /^[a-z][a-z0-9-]*$/;
const HEADER = /^(\d{1,15}) ([a-z][a-z0-9-]*)\n/;
// What makes the forwarded request the window's: its session cookie (named after the host's port) and origin.
const FORWARDED = ['cookie', 'host', 'origin', 'user-agent', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for'];

export const createOcForgeServiceSocket = ({ server, uiAuthController, isRequestOriginAllowed, rejectWebSocketUpgrade }) => {
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: MESSAGE_MAX_BYTES });
  const httpAgent = new http.Agent({ keepAlive: true });
  const httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });

  /** The server's own address, as seen from inside: a wildcard bind is reached on loopback. */
  const ownAddress = () => {
    const address = server.address();
    if (!address || typeof address === 'string') return null;
    const host = address.address === '::' || address.address === '0.0.0.0' ? '127.0.0.1' : address.address;
    return { host, port: address.port, secure: typeof server.setSecureContext === 'function' };
  };

  const forward = (headers, guestId, payload, inFlight) => new Promise((resolve) => {
    const target = ownAddress();
    if (!target) {
      resolve({ status: 503, text: 'null' });
      return;
    }
    const request = (target.secure ? https : http).request({
      host: target.host,
      port: target.port,
      method: 'POST',
      path: `/api/guests/${guestId}/service/request`,
      headers: { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      agent: target.secure ? httpsAgent : httpAgent,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        inFlight.delete(request);
        resolve({ status: response.statusCode ?? 502, text: Buffer.concat(chunks).toString('utf8') });
      });
      response.on('error', () => {
        inFlight.delete(request);
        resolve({ status: 502, text: 'null' });
      });
    });
    request.on('error', () => {
      inFlight.delete(request);
      resolve({ status: 502, text: 'null' });
    });
    inFlight.add(request);
    request.end(payload);
  });

  const attach = (ws, req) => {
    const headers = {};
    for (const name of FORWARDED) {
      if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
    }
    // Requests still running when the window goes are ended, a long-poll included.
    const inFlight = new Set();
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const message = data.toString('utf8');
      const header = HEADER.exec(message);
      if (!header || !GUEST_ID.test(header[2])) return;
      const id = header[1];
      void forward(headers, header[2], message.slice(header[0].length), inFlight).then(({ status, text }) => {
        if (ws.readyState === ws.OPEN) ws.send(`${id} ${status}\n${text}`);
      });
    });
    ws.on('close', () => {
      for (const request of inFlight) request.destroy();
      inFlight.clear();
    });
    ws.on('error', () => {
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    });
  };

  // The gate of OpenChamber's own guest sockets (lib/guests/surface.js).
  const upgradeHandler = (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname;
    } catch {
      return;
    }
    if (pathname !== OC_FORGE_SERVICE_SOCKET_PATH) return;
    const handleUpgrade = async () => {
      try {
        if (isOpaqueOriginRequest(req)) {
          rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
          return;
        }
        if (!uiAuthController?.enabled && !await isPasswordlessSocketOriginAllowed(req, isRequestOriginAllowed)) {
          rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
          return;
        }
        if (uiAuthController?.enabled) {
          const sessionToken = await uiAuthController.ensureSessionToken?.(req, null);
          if (!sessionToken) {
            rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
            return;
          }
          if (!await isRequestOriginAllowed(req)) {
            rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
            return;
          }
        }
        if (!ownAddress()) {
          rejectWebSocketUpgrade(socket, 404, 'Not available');
          return;
        }
        wsServer.handleUpgrade(req, socket, head, (ws) => attach(ws, req));
      } catch {
        rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
      }
    };
    void handleUpgrade();
  };

  server.on('upgrade', upgradeHandler);
  return {
    dispose() {
      server.off('upgrade', upgradeHandler);
      httpAgent.destroy();
      httpsAgent.destroy();
    },
  };
};
