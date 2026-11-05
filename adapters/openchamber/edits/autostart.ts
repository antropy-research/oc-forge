// Services that start with OpenChamber (`ocForge.autostart`): once the guest
// routes are registered, and again after every catalog change (server/autostart.js).
import { insertAfter, insertBefore, replace, type Adapter } from "../apply"

export const autostart: Adapter = {
  name: "autostart",
  summary: "an extension's service may start with the server (`ocForge.autostart`), and again after each extension change",
  edits: {
    "packages/web/server/lib/opencode/feature-routes-runtime.js": [
      insertAfter(
        "import { listInstalledGuests, registerBuiltInGuests } from '../guests/catalog.js';",
        "\nimport { createOcForgeAutostart } from '../oc-forge/autostart.js';",
      ),
      insertBefore(
        "    stopGuestPackageWatch();\n    ({ stopPackageWatch: stopGuestPackageWatch } = registerGuestRoutes(app, {",
        "    // oc-forge: the services of extensions that ask start now, not on their first request (`ocForge.autostart`).\n" +
          "    const ocForgeAutostart = createOcForgeAutostart({\n" +
          "      listGuests: () => listInstalledGuests({ persistPath: extensionsPersistPath(openchamberDataDir) }),\n" +
          "      persistPath: extensionsPersistPath(openchamberDataDir),\n" +
          "    });\n" +
          "    ocForgeAutostart.soon();\n",
      ),
      replace(
        "      onGuestsChanged: () => announceChange('openchamber:guests-changed'),",
        "      onGuestsChanged: () => {\n" +
          "        announceChange('openchamber:guests-changed');\n" +
          "        // oc-forge: an install, update, rebuilt folder, enable or approval starts such a service again.\n" +
          "        ocForgeAutostart.soon();\n" +
          "      },",
      ),
    ],
  },
}
