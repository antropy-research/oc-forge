# Planner extension

Sunsama-style daily planning inside OpenChamber, built as an SDK extension
(manifest `apiVersion` 1, OpenChamber 2.4.0 or newer; extensions load on web and
desktop only).

Current slice: a full page and a rail panel listing every registered project with
the live state of its top-level sessions (running, waiting for you, failed).
Planning data (Today, Backlog, time blocks) comes in later slices. An idle session
only means the agent stopped; it never marks planned work done.

| Path | Contents |
|---|---|
| `package.json` | manifest: panel `oc-forge-planner`, `page: true`, capability `sessions` |
| `panel/index.html` | frame shell; styles use the host theme variables (`--oc-*`) |
| `panel/main.ts` | source; `panel/main.js` is the built classic IIFE, committed so the folder installs without a build |
| `tsconfig.json` | strict type check (`bun run check`) |

Build, run and install: [`containers/openchamber-dev/README.md`](../../containers/openchamber-dev/README.md).
