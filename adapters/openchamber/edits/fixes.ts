// Host bugs the extensions run into, worked around until upstream fixes them.
// OpenCode 2.2 answers a folder's first command list with none; OpenChamber's
// send then takes `/name args` for a plain prompt (host/commands.ts).
import { insertAfter, replace, type Adapter } from "../apply"

export const fixes: Adapter = {
  name: "fixes",
  summary: "a slash command sent first in a folder whose commands OpenCode 2.2 has not loaded yet still runs as the command",
  edits: {
    "packages/ui/src/sync/session-ui-store.ts": [
      insertAfter(
        'import { resolveProjectForSessionDirectory } from "@/lib/projectResolution"',
        "\nimport { ocForgeCommandsOnceLoaded } from '@/oc-forge/commands'",
      ),
      replace(
        "        opencodeClient.listCommands(requestDirectory),\n        useSkillsStore.getState().loadSkills(requestDirectory),",
        "        // oc-forge: OpenCode 2.2 answers a folder's first command list with none.\n" +
          "        ocForgeCommandsOnceLoaded(() => opencodeClient.listCommands(requestDirectory)),\n" +
          "        useSkillsStore.getState().loadSkills(requestDirectory),",
      ),
    ],
  },
}
