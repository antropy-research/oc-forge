# Planner extension

Sunsama's daily planning inside OpenChamber, with agents as part of the plan:
collect work, plan the day, focus or hand a task to an agent, answer its questions,
review the result, and close the day and the week. Built as an OpenChamber SDK
extension (manifest `apiVersion` 1; SDK 2.5.1, tested on OpenChamber 2.5.1, the latest
release; web and desktop).

Plan and progress live in the zmemory project: `.tasks/1024-planner-sunsama-features-plan.md`,
`.tasks/1025-planner-agents-md-requirements-plan.md` and
`02-draft/syncopation/2026-10-24-planner-sunsama-build-log.md`.

## Architecture

| Part | Path | Role |
|---|---|---|
| Domain | `src/domain/` | Types, events and validation, reducer, rollover, recurrence, scheduling (free slots, lanes, playlist), ICS parsing, Linear/GitHub mapping, agent runs, rituals, suggestions, Braindump and assistant parsing. Pure; shared by service and panel. |
| Service | `service/` → `service/main.js` | Local Node service the host starts on the first `serviceRequest`: validates commands, appends events, folds state, commits history, syncs with a git remote, fetches ICS feeds, reads GitHub through `gh` (issues, and the pull requests agents open), keeps the API keys of extra Linear workspaces and runs the Planner's Linear queries with them, signs in Google accounts and talks to Google Calendar, Google Tasks and Gmail, and writes working sessions to Google Calendar. |
| Panel | `panel/` → `panel/main.js` | Preact UI bundled as a classic IIFE. One bundle serves the full page, the rail panel, the Work Status section and a hidden background frame (message actions and slash commands). Markdown is parsed with `marked`'s lexer and drawn as plain elements (`panel/lib/markdown.ts`): raw HTML stays text, only http(s) and mailto links, images become links, never `innerHTML`. |
| Tests | `tests/*.test.ts`, `tests/e2e/run.mjs`, `tests/e2e/calendar.mjs` | `bun test` for domain and service (Google writes through a mocked `fetch`, and the service run against `tests/e2e/fakeGoogle.mjs`); a Playwright journey against the dev container (`containers/openchamber-dev`); `calendar.mjs` drives Google Calendar and Google Tasks in the container's UI with this checkout's build (`tests/e2e/harness.mjs`), its service signed in to the fake Google. |

**Data.** An append-only event log, `events/YYYY-MM.jsonl`, in a git repository at
`~/.local/share/openchamber-planner/data` on the machine running OpenChamber. State is
a fold over the log in `(at, id)` order; the panel applies each command optimistically
through the same reducer and then takes the service's answer. Event files merge with
git's union driver, rollover is idempotent, recurring instances and default channels
have stable ids, so several machines can share one plan through a git remote.

**Sources.** Tasks can be personal (no source), linked to a Linear issue, a GitHub issue
or pull request (read-only, through the `gh` CLI), a Google task, or a Gmail message.
Agent runs link tasks to OpenChamber sessions in any registered project.

**Google.** OpenChamber gives an extension one integration (the Planner's is Linear) and
its OAuth callback needs HTTPS or localhost, so Google's sign-in runs in the service, with
a "Desktop app" OAuth client from the user's own Google Cloud project: PKCE, a one-off
loopback listener for Google's redirect, or the redirect's address pasted back when the
browser is on another machine. It asks only for the chosen features' scopes (Calendar
events and calendar list, Tasks, Gmail read-only). The client secret and refresh tokens
stay in `~/.local/share/openchamber-planner/google-accounts.json` (mode 0600, outside the
synced data repository) and never reach the panel; removing an account revokes it. Every
Google call ends within 12 s, as the host restarts a service that takes 20 s to answer.
Creating, changing, answering, moving and deleting events uses the same Calendar events
scope the working sessions already need, and Google Tasks its one Tasks scope, so no
feature asks for more than before. Lists are read page after page (calendars, events,
task lists, tasks); where the service stops reading it says so. Changes to a recurring
event are planned in `src/domain/gevents.ts`: "This and following events" ends the series
with UNTIL (counting earlier occurrences through `events.instances` for a series with
COUNT) and starts a new one, deleting the new one again if ending the old one fails.
Tests point the service at a fake Google with `PLANNER_GOOGLE_API_BASE`, which takes only
a `http://127.0.0.1:<port>/` address.

**Linear workspaces** (modelled on Orca's Linear integration). OpenChamber's own Linear
connection (`integration.host.provider = "linear"`) reaches one workspace; more are added
in Settings → Linear with a personal API key. The service keeps those keys in
`~/.local/share/openchamber-planner/linear-workspaces.json` (mode 0600, outside the synced
data repository), never returns them to the panel, and runs only the Planner's own GraphQL
documents with them; a mutation may carry only the fields the Planner edits. Each link records its workspace (`source.workspaceId`, the Linear
organization id), so reads and writes go to the right one; links made before workspaces
belong to OpenChamber's connection. A pasted issue URL is looked up in the workspace its
URL names.

## What it does (Sunsama feature by feature)

| Area | In the Planner |
|---|---|
| Home / Today / Focus | Multi-day board with a date jump; Today with Calendar, Backlog, Linear, GitHub, Google Tasks and Gmail beside it; Focus with timer, subtasks, notes, up/down, Pomodoro, Done for the day; rail-panel Today. |
| Tasks | Title, notes, subtasks (a subtask can become a task), planned and actual time, channel, priority, start (day or backlog bucket), due date, objective, folder, repeat, activity log, duplicate, archive, trash, undo. |
| Add Task syntax | `~30m`, `@tomorrow` / `@fri` / `@oct 30` / `@backlog` / `@someday`, `#channel`, `!high`, `$objective`; a pasted Linear issue URL links the issue; `A` opens the Add task window. |
| Backlog | Six time buckets, folders, search, channel and context filters, Braindump (line by line, or organized by the Small Model and reviewed before adding). |
| Channels | Work and personal contexts; personal time stays out of the workload; filters; delete keeps tasks. |
| Workload | Planned time per day against a threshold; history-based estimate and channel suggestions; auto-sort; playlist times (when each open task would run in order). |
| Calendar | Laid out as Google Calendar: a rail with Create (an event or a task), the mini month and "My calendars" / "Other calendars" with colored checkboxes ("Display this only", a color); Today, the arrows, the range title and the view (Day, Week, Month, Schedule; keys D, W, M, 5, J, K; show weekends, declined events, completed tasks); Calendar or Tasks. Day and week grids with an all-day row of bars; Month with bars, dotted timed events and "N more"; Schedule as Google's agenda. Click or drag on the grid (or click a month day) for quick create: an Event in a chosen Google calendar, or a Task planned in the Planner at that time and added to a Google Tasks list; "More options" opens the editor (times, all day, repeat presets and a custom rule, calendar, Google Meet, place, notifications, color, busy/free, visibility, description, guests). Click an event for its details (time, how it repeats, Meet, place, guests and their answers, description, notifications, calendar) with Edit, Delete, RSVP (Yes, No, Maybe), "Plan as task" and Options → Duplicate (the editor opens with a copy). Drag Google events to move them and their bottom edge to resize them; a recurring event asks This event, This and following events or All events, an event with guests whether to email them; everything is written to Google Calendar, and a snackbar says so, with Undo after moving or resizing one event. Unanswered, maybe and declined invitations show as Google draws them. Working sessions as before: drop tasks to timebox, drag, resize, remove; moving a session moves its task; auto-schedule into free time; sessions written to a chosen Google calendar follow it both ways. Google tasks with a date show on that day in the all-day row, completed ones struck through, planned ones marked and linked to their Planner task, whenever an account with Tasks is connected; their details complete, delete or plan them, and dragging one to another day changes its date. Any event becomes a task on its day with its length as planned time; read-only ICS subscriptions (RRULE, EXDATE, overrides, time zones). The rail and the unscheduled-tasks panel fold away when the week would get too narrow (the menu button and the panel button bring them back). |
| Time | One running timer, manual entries, actual vs planned, planned counts as actual (setting); a running-timer bar. |
| Rituals | Daily planning (5 steps, plans tomorrow after 3 PM), daily shutdown, daily highlights (stars, custom items, AI summary, publish), weekly objectives, weekly planning (carry over), weekly review (progress, body of work, time by channel). |
| Rollover | At local midnight, with catch-up after downtime; rollover count; archive after N rollovers. |
| Recurrence | Daily, weekdays, every n weeks on chosen days, monthly (end-of-month aware), yearly; instances a week ahead; untouched instances give way to the next one; apply edits to upcoming; stop. |
| Stats | Completed tasks, actual time, actual vs planned, days planned, streak, work per day, time by channel. |
| Search & keys | Ctrl/Cmd+K palette (navigate, act, find any task, ask the assistant); `A`, `T`, `F`, `P`, `O`, and `C` / `Z` / `X` on the hovered card. |
| Linear | Several workspaces, shown merged or one at a time; Issues (My issues, every saved view, search: views grouped with favorites first, opened with the layout, grouping and ordering saved with them), Linear-style temporary filters (status, assignee, priority, label, project, team, cycle, due date, workspace; is / is not; chips to edit or remove), Projects (status, health, progress, lead, dates, teams; a project's open issues, milestones, latest update and description) and Planned (issues already in the plan, by day); group by status, priority, project, team, assignee or workspace, order by priority, update, due date or number; list or board, where dropping a card on a status column moves the issue in Linear; plan by click or drag (also onto the calendar); keys and states on cards; completing asks (or always / never) to move the issue to Done; optional move to In Progress when planned; optional completion import; create an issue from a task in any workspace's team; an agent's new worktree defaults to Linear's branch name for the issue. Edit an issue in the Planner (click its title, or Edit issue on a linked task): status, priority, assignee, labels and due date apply at once; title and Markdown description (Write / Preview, a formatting bar, Ctrl+B / Ctrl+I / Ctrl+Enter) save together, and a save that would overwrite a change made in Linear meanwhile asks first; tick checklist items in place; read and post Markdown comments; links to issues open in the same editor. |
| GitHub | Assigned issues, review requests, my open PRs (read-only, like Sunsama); plan and drag like Linear; linked items keep their state and title. |
| Google Tasks | A Tasks view as the Google Tasks app (Calendar → Tasks, or Google → Google Tasks): lists in a sidebar (All tasks side by side or one list; create, rename, delete, the default list kept), each list's tasks in their order with subtasks one level in, "Add a task" at the top (it stays open for the next one), edit in place (title, details, date), add a subtask, drag to reorder, drag right to nest, Indent / Unindent / Move up / Move down / Move to another list, complete (its subtasks too) and reopen, a "Completed (n)" section, delete. A list's menu sorts by My order or Date (past, each day, then no date) and deletes all its completed tasks after asking. Changes made in Google Tasks come in every two minutes and when the window comes back. Each task shows the Planner task planning it; plan it today or tomorrow from its menu, or drag it onto a day or the calendar. Google's Tasks API keeps no due time and no stars: the date field and Starred say so instead. In Today's panel, a list's open tasks to plan as before; a linked task follows renames and (setting) completion in Google; completing or reopening it here does the same there (complete, ask or leave it); planning it on a day makes it due that day; add any task to Google Tasks from its detail. |
| Gmail | Inbox, unread, starred or any Gmail search, a page at a time ("Load more messages"); a message becomes a task with its sender and snippet, linked back to the thread (read-only). |
| Agents | Assign a task to an agent, as in GitHub or Linear (task detail, card menu, or Agent on a Linear or GitHub issue row): a new worktree on Linear's branch name or `planner/<title>`, and instructions to commit, push and open a pull request with `gh pr create` that links the issue; the run follows that pull request (Open, Draft, Merged, Closed) and a merged one offers to complete the task. OpenChamber does not let an extension pick the agent or model, so its defaults take the task. Or send a task to an agent in a project folder or a new or existing worktree; the task travels as a chip; runs show working, has a question, needs permission, ready for review, failed; Accept and complete is the user's call; Agents page; Work Status line; rail badge. From a chat: "Add to Planner" on a message, "Track chat in Planner", `/task`, `/today`. |
| Assistant | Ask Planner: the request and a compact plan go to the Small Model; known operations on known tasks only; preview, apply, undo. |
| Sync | Git remote for the data repository (a private GitHub repo or any git URL); sync after changes and every 5 minutes; Sync now. |

## Setup

1. Install the folder in OpenChamber and approve its access in Settings → Extensions:
   `sessions` and `prompt` (agents), `model` (summaries, Braindump, assistant), `service`
   (the local service; it may run `git` and `gh`), `network` (Linear).
2. Linear: Settings → Integrations → Linear in OpenChamber (or Connect in the Planner).
   The Planner never disconnects OpenChamber's Linear connection. Further workspaces:
   Planner → Settings → Linear → paste a personal API key (Linear → Settings → Security &
   access → Personal API keys). The key needs read access, and write access to move,
   create or edit issues and to comment.
3. Sync (optional): Settings → Sync → a remote such as `git@github.com:you/planner-data.git`.
   The service uses that machine's git credentials.
4. GitHub (optional): install `gh` on the machine running OpenChamber and `gh auth login`.
   Assigned agents open their pull requests with the same `gh`.
5. Google (optional): in a Google Cloud project, enable the Google Calendar, Google Tasks
   and Gmail APIs, set up the OAuth consent screen (yourself as a test user), and create an
   OAuth client ID of type Desktop app. Planner → Settings → Google: paste its ID and
   secret, then Connect a Google account with Calendar, Tasks and Gmail as wanted. Tick the
   calendars to show, and choose the one working sessions are written to.
6. AI features need a Small Model (a provider key, or Settings → Sessions → Small Model);
   without one they say so and the rest works.

## Limits of an OpenChamber extension

No mobile or VS Code surface, no tray, menu bar or global shortcut, no notifications when
no Planner surface is open, one integration slot (Linear; further Linear workspaces use API
keys, Google signs in through the service), no choice of agent or model for an agent run
(OpenChamber's defaults), no Outlook, Slack or Teams, Gmail read-only, no team sharing.
Google's own APIs set further limits: Google Tasks has no due time and no stars for other
apps (a task shows on its day in the all-day row), and Google Calendar's Year view,
appointment schedules, working location and the search box are not part of the Planner.
Undo covers moving or resizing one event; a deleted event or a changed series has none.

## Develop

From `containers/openchamber-dev`:

```sh
docker compose exec -w /extensions/planner openchamber bun install
docker compose exec -w /extensions/planner openchamber bun run check   # tsc, strict
docker compose exec -w /extensions/planner openchamber bun test tests/
docker compose exec -w /extensions/planner openchamber sh -c 'LINEAR_SCHEMA=/tmp/linear-schema.graphql bun test tests/linear.test.ts'
docker compose exec -w /extensions/planner openchamber bun run build   # panel/main.js + service/main.js
node ../../extensions/planner/tests/e2e/run.mjs http://<bind>:35310     # on the host
node ../../extensions/planner/tests/e2e/calendar.mjs /tmp/planner-calendar   # this build, a fake Google
```

The built `panel/main.js` and `service/main.js` are committed so the folder installs
without a build. The repository's root `.gitignore` ignores `lib/`; this package's own
`.gitignore` re-includes `panel/lib/`. A manifest that changes capabilities or service
permissions needs approval again. The e2e journey cleans up before and after itself
(tasks, chats, worktrees, folders, calendars, the Linear page layout, the Google session
calendar) and mocks Linear and the Small Model at the host's routes, and a second Linear
workspace, Google and pull request lookups at the service's routes, so it never touches a
real Linear workspace or Google account. Its one real Linear call
sends a made-up key, to check that the service refuses a key Linear rejects.
