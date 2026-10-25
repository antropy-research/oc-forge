# Planner extension

Sunsama's daily planning inside OpenChamber, with agents as part of the plan:
collect work, plan the day, focus or hand a task to an agent, answer its questions,
review the result, and close the day and the week. Built as an OpenChamber SDK
extension (manifest `apiVersion` 1, OpenChamber 2.4.0 or newer; web and desktop).

Plan and progress live in the zmemory project: `.tasks/1024-planner-sunsama-features-plan.md`
and `02-draft/syncopation/2026-10-24-planner-sunsama-build-log.md`.

## Architecture

| Part | Path | Role |
|---|---|---|
| Domain | `src/domain/` | Types, events and validation, reducer, rollover, recurrence, scheduling (free slots, lanes, playlist), ICS parsing, Linear/GitHub mapping, agent runs, rituals, suggestions, Braindump and assistant parsing. Pure; shared by service and panel. |
| Service | `service/` → `service/main.js` | Local Node service the host starts on the first `serviceRequest`: validates commands, appends events, folds state, commits history, syncs with a git remote, fetches ICS feeds, reads GitHub through `gh`, keeps the API keys of extra Linear workspaces and runs the Planner's Linear queries with them. |
| Panel | `panel/` → `panel/main.js` | Preact UI bundled as a classic IIFE. One bundle serves the full page, the rail panel, the Work Status section and a hidden background frame (message actions and slash commands). |
| Tests | `tests/*.test.ts`, `tests/e2e/run.mjs` | `bun test` for domain and service; a Playwright journey against the dev container (`containers/openchamber-dev`). |

**Data.** An append-only event log, `events/YYYY-MM.jsonl`, in a git repository at
`~/.local/share/openchamber-planner/data` on the machine running OpenChamber. State is
a fold over the log in `(at, id)` order; the panel applies each command optimistically
through the same reducer and then takes the service's answer. Event files merge with
git's union driver, rollover is idempotent, recurring instances and default channels
have stable ids, so several machines can share one plan through a git remote.

**Sources.** Tasks can be personal (no source), linked to a Linear issue, or linked to
a GitHub issue or pull request (read-only, through the `gh` CLI). Agent runs link tasks
to OpenChamber sessions in any registered project.

**Linear workspaces** (modelled on Orca's Linear integration). OpenChamber's own Linear
connection (`integration.host.provider = "linear"`) reaches one workspace; more are added
in Settings → Linear with a personal API key. The service keeps those keys in
`~/.local/share/openchamber-planner/linear-workspaces.json` (mode 0600, outside the synced
data repository), never returns them to the panel, and runs only the Planner's own GraphQL
documents with them. Each link records its workspace (`source.workspaceId`, the Linear
organization id), so reads and writes go to the right one; links made before workspaces
belong to OpenChamber's connection. A pasted issue URL is looked up in the workspace its
URL names.

## What it does (Sunsama feature by feature)

| Area | In the Planner |
|---|---|
| Home / Today / Focus | Multi-day board with a date jump; Today with Calendar, Backlog, Linear and GitHub beside it; Focus with timer, subtasks, notes, up/down, Pomodoro, Done for the day; rail-panel Today. |
| Tasks | Title, notes, subtasks (a subtask can become a task), planned and actual time, channel, priority, start (day or backlog bucket), due date, objective, folder, repeat, activity log, duplicate, archive, trash, undo. |
| Add Task syntax | `~30m`, `@tomorrow` / `@fri` / `@oct 30` / `@backlog` / `@someday`, `#channel`, `!high`, `$objective`; a pasted Linear issue URL links the issue; `A` opens the Add task window. |
| Backlog | Six time buckets, folders, search, channel and context filters, Braindump (line by line, or organized by the Small Model and reviewed before adding). |
| Channels | Work and personal contexts; personal time stays out of the workload; filters; delete keeps tasks. |
| Workload | Planned time per day against a threshold; history-based estimate and channel suggestions; auto-sort; playlist times (when each open task would run in order). |
| Calendar | Day/week grid; drop tasks to timebox; drag, resize, remove working sessions; moving a session moves its task, moving a card drops the sessions of the day it left; auto-schedule into free time; read-only ICS subscriptions (RRULE, EXDATE, overrides, time zones). |
| Time | One running timer, manual entries, actual vs planned, planned counts as actual (setting); a running-timer bar. |
| Rituals | Daily planning (5 steps, plans tomorrow after 3 PM), daily shutdown, daily highlights (stars, custom items, AI summary, publish), weekly objectives, weekly planning (carry over), weekly review (progress, body of work, time by channel). |
| Rollover | At local midnight, with catch-up after downtime; rollover count; archive after N rollovers. |
| Recurrence | Daily, weekdays, every n weeks on chosen days, monthly (end-of-month aware), yearly; instances a week ahead; untouched instances give way to the next one; apply edits to upcoming; stop. |
| Stats | Completed tasks, actual time, actual vs planned, days planned, streak, work per day, time by channel. |
| Search & keys | Ctrl/Cmd+K palette (navigate, act, find any task, ask the assistant); `A`, `T`, `F`, `P`, `O`, and `C` / `Z` / `X` on the hovered card. |
| Linear | Several workspaces, shown merged or one at a time; Issues (My issues, custom views, search), Projects (status, health, progress, lead, dates, teams; a project's open issues, milestones, latest update and description) and Planned (issues already in the plan, by day); group by status, priority, project, team, assignee or workspace, order by priority, update, due date or number; list or board, where dropping a card on a status column moves the issue in Linear; plan by click or drag (also onto the calendar); keys and states on cards; completing asks (or always / never) to move the issue to Done; optional move to In Progress when planned; optional completion import; create an issue from a task in any workspace's team; an agent's new worktree defaults to Linear's branch name for the issue. |
| GitHub | Assigned issues, review requests, my open PRs (read-only, like Sunsama); plan and drag like Linear; linked items keep their state and title. |
| Agents | Send a task to an agent in a project folder or a new or existing worktree; the task travels as a chip; runs show working, has a question, needs permission, ready for review, failed; Accept and complete is the user's call; Agents page; Work Status line; rail badge. From a chat: "Add to Planner" on a message, "Track chat in Planner", `/task`, `/today`. |
| Assistant | Ask Planner: the request and a compact plan go to the Small Model; known operations on known tasks only; preview, apply, undo. |
| Sync | Git remote for the data repository (a private GitHub repo or any git URL); sync after changes and every 5 minutes; Sync now. |

## Setup

1. Install the folder in OpenChamber and approve its access in Settings → Extensions:
   `sessions` and `prompt` (agents), `model` (summaries, Braindump, assistant), `service`
   (the local service; it may run `git` and `gh`), `network` (Linear).
2. Linear: Settings → Integrations → Linear in OpenChamber (or Connect in the Planner).
   The Planner never disconnects OpenChamber's Linear connection. Further workspaces:
   Planner → Settings → Linear → paste a personal API key (Linear → Settings → Security &
   access → Personal API keys). The key needs read access, and write access to move or
   create issues.
3. Sync (optional): Settings → Sync → a remote such as `git@github.com:you/planner-data.git`.
   The service uses that machine's git credentials.
4. GitHub (optional): install `gh` on the machine running OpenChamber and `gh auth login`.
5. AI features need a Small Model (a provider key, or Settings → Sessions → Small Model);
   without one they say so and the rest works.

## Limits of an OpenChamber extension

No mobile or VS Code surface, no tray, menu bar or global shortcut, no notifications when
no Planner surface is open, one integration slot (Linear; further Linear workspaces use API keys), no two-way Google/Outlook
calendars (read-only ICS instead), no mail, Slack or Teams, no team sharing.

## Develop

From `containers/openchamber-dev`:

```sh
docker compose exec -w /extensions/planner openchamber bun install
docker compose exec -w /extensions/planner openchamber bun run check   # tsc, strict
docker compose exec -w /extensions/planner openchamber bun test tests/
docker compose exec -w /extensions/planner openchamber sh -c 'LINEAR_SCHEMA=/tmp/linear-schema.graphql bun test tests/linear.test.ts'
docker compose exec -w /extensions/planner openchamber bun run build   # panel/main.js + service/main.js
node ../../extensions/planner/tests/e2e/run.mjs http://<bind>:35310     # on the host
```

The built `panel/main.js` and `service/main.js` are committed so the folder installs
without a build. The repository's root `.gitignore` ignores `lib/`; this package's own
`.gitignore` re-includes `panel/lib/`. A manifest that changes capabilities or service
permissions needs approval again. The e2e journey cleans up before and after itself
(tasks, chats, worktrees, folders, calendars, the Linear page layout) and mocks Linear and
the Small Model at the host's routes, and a second Linear workspace at the service's
`/linear/*` routes, so it never touches a real Linear workspace. Its one real Linear call
sends a made-up key, to check that the service refuses a key Linear rejects.
