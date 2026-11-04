// R2: extension tabs in the header's strip, after the session tabs. The page
// opened from a tab keeps the strip (the release swaps it for "← title"), and
// OpenChamber's own tab shortcuts reach the extension tabs too. The strip keeps
// the selected extension tab in view as it keeps the selected session's, and
// while extension tabs overflow it a button at its end lists every tab. While
// an extension tab is selected, no session tab, the new session's draft tab
// included, shows as selected, and the close-tab key (the desktop app's
// Cmd/Ctrl+W too) closes the extension tab. The page staying mounted behind
// its tabs is the core adapter's OcForgeGuestPages.
import { insertAfter, insertBefore, replace, type Adapter } from "../apply"

export const tabs: Adapter = {
  name: "tabs",
  summary: "extension tabs in the header strip beside the session tabs, kept-alive pages, tab shortcuts across both",
  edits: {
    "packages/ui/src/lib/sessionTabs.ts": [
      insertAfter(
        "import { useSessionUIStore } from '@/sync/session-ui-store';",
        "\nimport { ocForgeActivateAdjacentTab, ocForgeActivateTabByIndex } from '@/oc-forge/tabs-state';",
      ),
      replace(
        "export const activateSessionTabByIndex = (index: number): boolean => {",
        "const activateSessionTabByIndexInStrip = (index: number): boolean => {",
      ),
      replace(
        "export const activateAdjacentSessionTab = (delta: -1 | 1): boolean => {",
        "const activateAdjacentSessionTabInStrip = (delta: -1 | 1): boolean => {",
      ),
      insertBefore(
        "/**\n * Close one header session tab. Closing the active tab activates its right",
        "/** oc-forge: digits and previous/next go on past the session tabs into the extension tabs. */\n" +
          "export const activateSessionTabByIndex = (index: number): boolean => (\n" +
          "  ocForgeActivateTabByIndex(index, activateSessionTabByIndexInStrip)\n" +
          ");\n\n" +
          "export const activateAdjacentSessionTab = (delta: -1 | 1): boolean => (\n" +
          "  ocForgeActivateAdjacentTab(delta, activateAdjacentSessionTabInStrip)\n" +
          ");\n\n",
      ),
    ],
    "packages/ui/src/components/layout/SessionTabsStrip.tsx": [
      insertAfter(
        "import { activateSessionTabByIndex, closeSessionTabAndActivateNeighbour } from '@/lib/sessionTabs';",
        "\nimport { leaveOcForgeTab, ocForgeCloseActiveTab, onOcForgeLeaveTabKey, useOcForgeActiveTabKey, useOcForgeTabActive, useOcForgeTabCount } from '@/oc-forge/tabs-state';\nimport { OcForgeAllTabs, OcForgeHeaderTabs } from '@/oc-forge/tabs-ui';",
      ),
      insertAfter(
        "  const activeSessions = useGlobalSessionsStore((state) => state.activeSessions);",
        "\n  // oc-forge: while an extension tab is selected no session tab is.\n  const ocForgeTabActive = useOcForgeTabActive();" +
          "\n  // oc-forge: the selected extension tab is kept in view too, and the fades follow extension tabs as they come and go." +
          "\n  const ocForgeActiveTabKey = useOcForgeActiveTabKey();\n  const ocForgeTabCount = useOcForgeTabCount();",
      ),
      insertAfter("  const handleSelect = React.useCallback((tab: SessionTab) => {", "\n    leaveOcForgeTab();"),
      // The desktop app's Cmd/Ctrl+W: while an extension tab is selected, it is the open tab, as for close_session_tab.
      replace(
        "  const hasClosableTab = tabs.some((tab) => tab.id === currentSessionId) || (showDraftTab && tabs.length > 0);",
        "  const hasClosableTab = ocForgeTabActive || tabs.some((tab) => tab.id === currentSessionId) || (showDraftTab && tabs.length > 0);",
      ),
      replace(
        "    return registerCloseTabTarget(() => {\n      const id = useSessionUIStore.getState().currentSessionId;",
        "    return registerCloseTabTarget(() => {\n      if (ocForgeCloseActiveTab()) return;\n      const id = useSessionUIStore.getState().currentSessionId;",
      ),
      replace("                isActive={tab.id === currentSessionId}", "                isActive={tab.id === currentSessionId && !ocForgeTabActive}"),
      replace(
        "  const showPendingTab = Boolean(currentSessionId) && !tabs.some((tab) => tab.id === currentSessionId);",
        "  const showPendingTab = Boolean(currentSessionId) && !tabs.some((tab) => tab.id === currentSessionId) && !ocForgeTabActive;",
      ),
      // The open draft's tab, as a session's tab: not selected while an extension tab is, and a click goes back to it.
      replace(
        "        {showDraftTab ? (\n" +
          "          <div\n" +
          "            role=\"tab\"\n" +
          "            aria-selected\n" +
          "            className=\"app-region-no-drag session-tab-slot flex h-7 w-44 shrink-0 items-center rounded-md bg-interactive-selection px-2 text-interactive-selection-foreground\"\n" +
          "            data-active=\"true\"\n" +
          "            data-active-session-tab\n" +
          "          >\n",
        "        {showDraftTab ? (\n" +
          "          <div\n" +
          "            role=\"tab\"\n" +
          "            aria-selected={!ocForgeTabActive}\n" +
          "            tabIndex={ocForgeTabActive ? 0 : undefined}\n" +
          "            onClick={ocForgeTabActive ? leaveOcForgeTab : undefined}\n" +
          "            onKeyDown={ocForgeTabActive ? onOcForgeLeaveTabKey : undefined}\n" +
          "            className={cn(\n" +
          "              'app-region-no-drag session-tab-slot flex h-7 w-44 shrink-0 items-center rounded-md px-2',\n" +
          "              ocForgeTabActive\n" +
          "                ? 'cursor-pointer text-muted-foreground hover:bg-interactive-hover hover:text-foreground'\n" +
          "                : 'bg-interactive-selection text-interactive-selection-foreground',\n" +
          "            )}\n" +
          "            data-active={ocForgeTabActive ? 'false' : 'true'}\n" +
          "            {...(ocForgeTabActive ? {} : { 'data-active-session-tab': true })}\n" +
          "          >\n",
      ),
      // Numbered on from the session tabs, as the tab shortcuts count them.
      insertAfter(
        "            <div className=\"min-w-0 flex-1\">{children}</div>\n          </div>\n        ) : null}",
        "\n        <OcForgeHeaderTabs firstNumber={tabs.length + 1} />",
      ),
      replace("  }, [updateEdges, tabs.length]);", "  }, [updateEdges, tabs.length, ocForgeTabCount]);"),
      replace("  }, [currentSessionId, updateEdges]);", "  }, [currentSessionId, ocForgeActiveTabKey, updateEdges]);"),
      // At the strip's end, after the "+" that follows the last tab.
      replace(
        "      </Tooltip>\n    </div>\n  );\n};",
        "      </Tooltip>\n" +
          "      <OcForgeAllTabs\n" +
          "        overflowing={edges.left || edges.right}\n" +
          "        sessions={tabs.map((tab) => ({ id: tab.id, title: tab.session.title?.trim() || t('sessions.sidebar.session.untitled'), active: tab.id === currentSessionId && !ocForgeTabActive }))}\n" +
          "        onSelectSession={(id) => {\n" +
          "          const tab = tabs.find((entry) => entry.id === id);\n" +
          "          if (tab) handleSelect(tab);\n" +
          "        }}\n" +
          "      />\n" +
          "    </div>\n  );\n};",
      ),
    ],
    // 2.6's title bar shows its own "New session" while a page hides the header tabs, and counts every extension page
    // as hiding them. A page on its header tabs keeps the strip and its "+" (Header.tsx below): no second "New
    // session" there, and none arriving as such a tab is chosen, whose room narrowed the strip after it had revealed
    // the tab.
    "packages/ui/src/components/layout/TitlebarLeftControls.tsx": [
      insertAfter("import { publishTitlebarControlsWidth } from './titlebarControlsWidth';", "\nimport { useOcForgeTabbedPage } from '@/oc-forge/tabs-state';"),
      replace(
        "  const tabsShown = useUIStore((state) => state.sessionTabsEnabled && !(",
        "  const ocForgeTabbedPage = useOcForgeTabbedPage(useUIStore((state) => state.openGuestPageId));\n" +
          "  const tabsShown = useUIStore((state) => state.sessionTabsEnabled && !(",
      ),
      replace(
        "    || state.runOverviewKey !== null || state.openGuestPageId !== null\n  ));",
        "    || state.runOverviewKey !== null || (state.openGuestPageId !== null && !ocForgeTabbedPage)\n  ));",
      ),
    ],
    "packages/ui/src/components/layout/Header.tsx": [
      insertAfter(
        "import { SessionTabsStrip, type SessionTabMenuArgs } from './SessionTabsStrip';",
        "\nimport { useOcForgeTabbedPage } from '@/oc-forge/tabs-state';",
      ),
      replace(
        "  const guestPage = useGuestsStore((state) => state.guests.find((guest) => guest.id === openGuestPageId));",
        "  // oc-forge: a page shown on one of its header tabs keeps the tab strip instead of \"← title\".\n" +
          "  const ocForgeTabbedPage = useOcForgeTabbedPage(openGuestPageId);\n" +
          "  const guestPage = useGuestsStore((state) => (ocForgeTabbedPage ? undefined : state.guests.find((guest) => guest.id === openGuestPageId)));",
      ),
    ],
    "packages/ui/src/hooks/useKeyboardShortcuts.ts": [
      insertAfter(
        "import { activateAdjacentSessionTab, activateSessionTabByIndex, closeSessionTabAndActivateNeighbour } from '@/lib/sessionTabs';",
        "\nimport { ocForgeCloseActiveTab } from '@/oc-forge/tabs-state';",
      ),
      insertBefore(
        "      if (currentSessionId) {\n        closeSessionTabAndActivateNeighbour(currentSessionId);",
        "      if (ocForgeCloseActiveTab()) return;\n",
      ),
    ],
  },
}
