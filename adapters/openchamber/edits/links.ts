// R5: `?extension=<id>&route=<route>` is a deep link to an extension's page.
// The router keeps those parameters instead of dropping them, applies them on
// load and on back/forward, and writes them while the page is open.
import { insertAfter, insertBefore, replace, type Adapter } from "../apply"

export const links: Adapter = {
  name: "links",
  summary: "?extension=<id>&route=<route> deep links: opened on load and back/forward, kept in the address bar while the page shows",
  edits: {
    "packages/ui/src/lib/router/parseRoute.ts": [
      insertAfter("import { isLinkIdentifier } from './messageFocus';", "\nimport { hasOcForgeRouteParams } from '@/oc-forge/routes';"),
      replace(
        "      params.has(ROUTE_PARAMS.FILE)\n    );",
        "      params.has(ROUTE_PARAMS.FILE) ||\n      hasOcForgeRouteParams(params)\n    );",
      ),
    ],
    "packages/ui/src/lib/router/serializeRoute.ts": [
      insertAfter("import { ROUTE_PARAMS } from './types';", "\nimport { ocForgeRouteParams } from '@/oc-forge/routes';"),
      insertBefore(
        "\n  return params;\n}",
        "\n  // oc-forge: the extension page the address bar names stays named.\n" +
          "  for (const [key, value] of ocForgeRouteParams()) params.set(key, value);\n",
      ),
    ],
    "packages/ui/src/hooks/useRouter.ts": [
      insertAfter("import { useDirectoryStore } from '@/stores/useDirectoryStore';", "\nimport { applyOcForgeRoute } from '@/oc-forge/routes';"),
      replace(
        "          navigateToDiff(route.diffFile);\n        }\n      } finally {",
        "          navigateToDiff(route.diffFile);\n        }\n\n        // 5. oc-forge: an extension page deep link (`?extension=<id>&route=<route>`).\n" +
          "        applyOcForgeRoute();\n      } finally {",
      ),
    ],
  },
}
