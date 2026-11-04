// Guest service requests over one WebSocket per window (host/service-socket.ts,
// host/service-transport.ts, server/service-socket.js): over plain HTTP/1.1 the
// browser's six connections per host, shared by a site's tabs, were all held by
// VS Code's tunnel long-polls once two windows were open, and both windows'
// other requests waited. The release's HTTP route still runs every request.
import { insertAfter, replace, type Adapter } from "../apply"

export const transport: Adapter = {
  name: "transport",
  summary: "guest service requests over one WebSocket per window, so long-polls never hold the browser's six HTTP connections per host",
  edits: {
    "packages/web/server/index.js": [
      insertAfter(
        "import { createGuestSurfaceRuntime } from './lib/guests/surface.js';",
        "\nimport { createOcForgeServiceSocket } from './lib/oc-forge/service-socket.js';",
      ),
      replace(
        "    idleStopMs: BROWSER_PROVIDER_IDLE_MS,\n  });\n",
        "    idleStopMs: BROWSER_PROVIDER_IDLE_MS,\n  });\n" +
          "  // oc-forge: guest service requests over one WebSocket per window (lib/oc-forge/service-socket.js).\n" +
          "  createOcForgeServiceSocket({ server, uiAuthController, isRequestOriginAllowed, rejectWebSocketUpgrade });\n",
      ),
    ],
    "packages/ui/src/lib/guests/service.ts": [
      insertAfter(
        "import { runtimeFetch } from '@/lib/runtime-fetch';",
        "\nimport { ocForgeServiceRequest } from '@/oc-forge/service-transport';",
      ),
      replace(
        "    const response = await runtimeFetch(`/api/guests/${guestId}/service/request`, {",
        "    // oc-forge: over the window's service socket when there is one (oc-forge/service-transport.ts).\n" +
          "    const viaSocket = await ocForgeServiceRequest(guestId, viewerId ? { ...request, viewerId } : request);\n" +
          "    if (viaSocket) return parseGuestServiceProxyResponse(viaSocket);\n" +
          "    const response = await runtimeFetch(`/api/guests/${guestId}/service/request`, {",
      ),
    ],
  },
}
