# Planner extension

Sunsama-style daily planning inside OpenChamber, built as an SDK extension
(manifest `apiVersion` 1, OpenChamber 2.4.0 or newer; extensions load on web and
desktop only). Plan and progress: Planner plan in the zmemory project
(`.tasks/1024-planner-sunsama-features-plan.md`).

## Architecture

| Part | Path | Role |
|---|---|---|
| Domain | `src/domain/` | Types, events, reducer, rollover, selectors, date math, Add Task syntax. Shared by the service and the panel. |
| Service | `service/` → `service/main.js` | Local Node service the host starts on the first `serviceRequest`; validates commands, appends events, folds state, commits history. |
| Panel | `panel/` → `panel/main.js` | Preact UI bundled as a classic IIFE; the same bundle renders the full page and the rail panel. |
| Tests | `tests/*.test.ts`, `tests/e2e/run.mjs` | `bun test` for domain and service; Playwright journey against the dev container. |

Data is an append-only event log, `events/YYYY-MM.jsonl`, in a git repository at
`~/.local/share/openchamber-planner/data` (inside the container's home volume).
Lines merge with git's union driver, so a GitHub remote can be added later without
conflicts. The panel applies each command optimistically through the same reducer,
then takes the service's answer.

## Sunsama behavior implemented so far

- Home board of day columns, Today view with the backlog beside it, rail-panel Today list.
- Add Task syntax: `~30m` planned time, `@tomorrow` / `@fri` / `@oct 30` / `@backlog` / `@someday`, `#channel`, `!high`.
- Backlog time buckets: next week or two, next month, next quarter, next year, someday, never.
- Drag and drop between days and buckets, reorder within a list, move/delete menu, inline rename and planned-time edit.
- Planned time per day against the workload threshold; personal-context channels stay out of the workload.
- Midnight rollover in the user's timezone with catch-up after downtime, rollover count, archive after N consecutive rollovers.
- Channels (default `work` and `personal`), settings for timezone, workload, archive threshold, week start.

## Develop

From `containers/openchamber-dev`:

```sh
docker compose exec -w /extensions/planner openchamber bun install
docker compose exec -w /extensions/planner openchamber bun run check   # tsc, strict
docker compose exec -w /extensions/planner openchamber bun test tests/
docker compose exec -w /extensions/planner openchamber bun run build   # panel/main.js + service/main.js
node ../../extensions/planner/tests/e2e/run.mjs http://<bind>:35310     # on the host
```

The built `panel/main.js` and `service/main.js` are committed so the folder installs
without a build. A manifest that adds a capability (such as the local service) needs
approval again in Settings → Extensions.
