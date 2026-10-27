# Planner extension

Sunsama's daily planning inside OpenChamber, with agents as part of the plan:
collect work, plan the day, focus or hand a task to an agent, answer its questions,
review the result, and close the day and the week. Built as an OpenChamber SDK
extension (manifest `apiVersion` 1; SDK 2.5.2, tested on OpenChamber 2.5.2, the latest
release; web and desktop).

Plan and progress live in the zmemory project: `.tasks/1024-planner-sunsama-features-plan.md`,
`.tasks/1025-planner-agents-md-requirements-plan.md` and
`02-draft/syncopation/2026-10-24-planner-sunsama-build-log.md`.

## Architecture

| Part | Path | Role |
|---|---|---|
| Domain | `src/domain/` | Types, events and validation, reducer, rollover, recurrence, scheduling (free slots, lanes, playlist), ICS parsing, Linear/GitHub mapping, agent runs, rituals, suggestions, Braindump and assistant parsing. Pure; shared by service and panel. |
| Service | `service/` → `service/main.js` | Local Node service the host starts on the first `serviceRequest`: validates commands, appends events, folds state, commits history, syncs with a git remote, fetches ICS feeds, reads GitHub through `gh` (issues, and the pull requests agents open), keeps the API keys of extra Linear workspaces and runs the Planner's Linear queries with them, signs in Google accounts and talks to Google Calendar, Google Tasks and Gmail, writes working sessions to Google Calendar, finds OpenCode's agents (its config folders, and its running server when it is up) and models (`opencode models`), and writes one OpenCode command per agent a task can be assigned to. |
| Panel | `panel/` → `panel/main.js` | Preact UI bundled as a classic IIFE. One bundle serves the full page, the rail panel, the Work Status section and a hidden background frame (message actions and slash commands). Markdown is parsed with `marked`'s lexer and drawn as plain elements (`panel/lib/markdown.ts`): raw HTML stays text, only http(s) and mailto links, images become links, never `innerHTML`. |
| Tests | `tests/*.test.ts`, `tests/e2e/` | `bun test` for domain, service and panel helpers (Google writes through a mocked `fetch`, and the service run against `tests/e2e/fakeGoogle.mjs`); `fakeGithub.test.ts` runs the real `gh` against `tests/e2e/fakeGithub.mjs`. Playwright journeys against the dev container (`containers/openchamber-dev`): `run.mjs` and `agentpr.mjs` on the installed extension (`agentpr.mjs`: a real agent opens a pull request against the fake GitHub), and `harness.mjs` journeys on this checkout's build: `smoke.mjs`, `sunsama.mjs`, `linear.mjs` and `calendar.mjs` (its service signed in to the fake Google). |

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
| Home / Today / Focus | Multi-day board with a date jump and Sunsama's right-hand panel: a vertical rail of sources (Calendar, Backlog, Linear, GitHub, Gmail, Google Tasks) beside the chosen one's list, folding down to the rail. A source's items drag onto any day column on screen, or onto the calendar shown under the list; each row plans with a click on the first days on screen, or on any visible day, the backlog or a date from its menu. Today has the same panel beside today's list. In a narrow page (OpenChamber's own sidebar open in a 1024 px window leaves about 700 px) the Planner's menu folds into a rail and opens over the page, as Sunsama and Linear fold theirs; the panel narrows so a whole day stays beside it, and dragging to the board's edge scrolls on to later days. Focus with timer, subtasks, notes, up/down, Pomodoro, Done for the day; rail-panel Today. |
| Tasks | Title, notes, subtasks (a subtask can become a task), planned and actual time, channel, priority, start (day or backlog bucket), due date, objective, folder, repeat, activity log, duplicate, archive, trash, undo. |
| Add Task syntax | `~30m`, `@tomorrow` / `@fri` / `@oct 30` / `@backlog` / `@someday`, `#channel`, `!high`, `$objective`; a pasted Linear issue URL links the issue; `A` opens the Add task window. |
| Backlog | Six time buckets, folders, search, channel and context filters, Braindump (line by line, or organized by the Small Model and reviewed before adding). |
| Channels | Work and personal contexts; personal time stays out of the workload; filters; delete keeps tasks. |
| Workload | Planned time per day against a threshold; history-based estimate and channel suggestions; auto-sort; playlist times (when each open task would run in order). |
| Calendar | Laid out as Google Calendar: a rail with Create (an event or a task), the mini month and "My calendars" / "Other calendars" with colored checkboxes ("Display this only", a color); Today, the arrows, the range title and the view (Day, Week, Month, Year, Schedule; keys D, W, M, Y, 5, J, K; show weekends, declined events, completed tasks); search (`/`, the matching events of the calendars shown, a year back and two ahead, day by day as in Schedule); Calendar or Tasks. A newly connected account's own calendar shows at once, as in Google; shared ones wait to be ticked. Day and week grids with an all-day row of bars, each block's title wrapping over the lines its height allows with the time on its own line when there is room ("Title, 10am" on one line for short blocks; the full text in its label and tooltip); Month with bars, dotted timed events and "N more"; Schedule as Google's agenda. Click or drag on the grid (or click a month day) for quick create: an Event in a chosen Google calendar, or a Task, as in Google Calendar: one Google task on that day in a chosen list, at that time (kept in the Planner; with "The Planner only" a Planner task with a working session instead); "More options" opens the editor (times, all day, repeat presets and a custom rule, calendar, Google Meet, place, notifications, color, busy/free, visibility, description, guests). Click an event for its details (time, how it repeats, Meet, place, guests and their answers, description, notifications, calendar) with Edit, Delete, RSVP (Yes, No, Maybe), "Plan as task" and Options → Duplicate (the editor opens with a copy). Drag Google events to move them and their bottom edge to resize them; a recurring event asks This event, This and following events or All events, an event with guests whether to email them; everything is written to Google Calendar, and a snackbar says so, with Undo after moving or resizing one event. Unanswered, maybe and declined invitations show as Google draws them. Working sessions as before: drop tasks to timebox, drag, resize, remove; moving a session moves its task; auto-schedule into free time; sessions written to a chosen Google calendar follow it both ways. Google tasks with a date show on that day in the all-day row, or at their time in the grid with their check circle when they have one, completed ones struck through, planned ones marked and linked to their Planner task, a deadline flagged (red once passed) and shown on its own day in the all-day section as Google's flag (a task with only a deadline shows there alone; a timed task keeps its block and has its deadline there too, its own day included; an all-day task due on its deadline's day is one item, with its flag), and a repeating task's upcoming occurrences at their dates and times (lighter, with its repeat mark; the real one replaces each once Google has it, never two for one date; their details show the series, with Edit all tasks and Delete all future tasks), in Day, Week, Month and Schedule, whenever an account with Tasks is connected; their details edit them (Edit opens the Tasks view's form over the calendar, which stays where it was: title, details, date and time, deadline, repeat, star and list; a repeating one asks This task or All tasks), complete, star, delete or plan them; dragging one to another day changes its date in Google (it keeps its time), dragging a timed one in the grid changes its time, and an all-day one dropped on the hours gets that time. Any event becomes a task on its day with its length as planned time; read-only ICS subscriptions (RRULE, EXDATE, overrides, time zones). The rail and the unscheduled-tasks panel fold away when the week would get too narrow (the menu button and the panel button bring them back). |
| Time | One running timer, manual entries, actual vs planned, planned counts as actual (setting); a running-timer bar. |
| Rituals | Daily planning (5 steps, plans tomorrow after 3 PM; collects from the backlog, Linear, GitHub, Gmail, Google Tasks, meetings and objectives, and every add lands on the day being planned), daily shutdown, daily highlights (stars, custom items, AI summary, publish), weekly objectives, weekly planning (carry over), weekly review (progress, body of work, time by channel). |
| Rollover | At local midnight, with catch-up after downtime; rollover count; archive after N rollovers. |
| Recurrence | Daily, weekdays, every n weeks on chosen days, monthly (end-of-month aware), yearly; instances a week ahead; untouched instances give way to the next one; apply edits to upcoming; stop. |
| Stats | Completed tasks, actual time, actual vs planned, days planned, streak, work per day, time by channel. |
| Search & keys | Ctrl/Cmd+K palette (navigate, act, find any task, ask the assistant); `A`, `T`, `F`, `P`, `O`, and `C` / `Z` / `X` on the hovered card; on the Linear page, Linear's keys (`F` filters there, `[` folds its sidebar). |
| Linear | Several workspaces, shown merged or one at a time. A page laid out like Linear, with its own sidebar: My issues (Assigned, Created, Subscribed), Planned (the issues already in the plan), Favorites (views, projects and issues), every saved view by team and workspace (searchable; views of issues and of projects) and Projects; ↑/↓ and Enter, `/` to search (as one types), `G` then `I`, `V` or `P`, `[` to fold it away; it reopens where it was (kept on this device). Where the page is too narrow for it (1024 px with OpenChamber's sidebar open), the sidebar folds behind a toggle in the header and opens over the list, closing on Escape, a pick or a click outside; the header's search then takes `/`, and rows put properties that do not fit under the title. A saved view lists exactly the issues Linear lists for it: its own filter, what its display hides (completed issues by its window, sub-issues, triage) and every page (three at once, the rest on scroll or Load more, never a silent cap), opened with its layout, grouping, sub-grouping, ordering and properties (anything shown another way is named); a view of projects lists its projects. Filters as in Linear: Filter or `F` opens a searchable, keyboard-first menu (properties, then values with ticks; typing finds a value of any property; ↑/↓, Enter, Esc, Backspace back) of status, assignee, creator, priority, labels, content (the title or description contains, or does not contain, a text), project, milestone, team, cycle, estimate, subscribers, relations (blocked by, blocking, related, duplicate, a parent issue, sub-issues), the due, created, updated and completed dates, and the workspace ("Me" is whoever reads, in each workspace); chips such as "Status is either of Todo, In Progress" whose operator (is / is not; include any / all / none for labels, subscribers and relations; before / after a date, besides overdue, today, this week, next week, no due date, or a time ago; at least / at most for estimates) and values can be changed; "Match all / any" for the top-level filters; Advanced filter (in the menu) builds Linear's rows joined by and / or, and groups of them nested two deep, each switching between all and any; a group shows in the bar as "Any of 2 filters" and opens in the builder; Clear. A saved view opens with its own filter (its `filterData`) in the bar, an "or" as one group: while it holds as saved Linear applies it; changed here, the Planner asks for the view's team's issues with the filters as they are (Reset brings the view's back); parts the Planner cannot edit show in words and still apply. The choices come from the workspaces (every state, person, label, project, milestone, cycle and estimate scale; a team's view offers its team's), and the filters go to Linear as an `IssueFilter` with `and` and `or`, so the answer is complete. Display (`Shift V`): list or board (`Cmd/Ctrl B`), grouping and sub-grouping (status, assignee, project, priority, cycle, label, team, workspace), ordering (manual, status, priority, last updated, last created, due date, number) and its direction, completed issues (all, past day to past year, none), sub-issues, empty groups or columns, triage, and the properties rows show; a view's changes last while it is open, the Planner's own lists keep theirs. Status groups and board columns are the teams' exact workflow states in Linear's order (same-named states of several teams share one); dropping a card sets exactly that state, or the group's priority, assignee, project or cycle, in the card's own team, and a state its team lacks is refused. Projects: status, health, progress, lead, dates and teams; a project's issues as a full list (filters, display, board), its milestones, latest update and description. The issue view is laid out like Linear's: the title and Markdown description (Write / Preview, a formatting bar, Ctrl+B / Ctrl+I / Ctrl+Enter; checklist items ticked in place; a save that would overwrite a change made in Linear meanwhile asks first), sub-issues, the activity (history and Markdown comments), and a properties sidebar (status, priority, assignee, labels, project, cycle, estimate, due date; links) whose searchable menus open with `S`, `P`, `A`, `L` and `Shift D`; `J` / `K` move to the next or previous issue of the list, `Esc` closes the menu, then the issue; each change sends only that field. Plan by click or drag (also onto the calendar); completing asks (or always / never) to move the issue to Done; optional move to In Progress when planned; optional completion import; create an issue from a task in any workspace's team; an agent's new worktree defaults to Linear's branch name for the issue. The panels beside Today, the calendar and planning keep a list of their own (my issues, a view or a search, with the same filters). |
| GitHub | Assigned issues, review requests, my open PRs (read-only, like Sunsama); plan and drag like Linear; linked items keep their state and title. When `gh` is missing or not signed in, the source says so and where to run `gh auth login` (inside the container when OpenChamber runs in one). |
| Google Tasks | A Tasks view as the Google Tasks app (Calendar → Tasks, or Google → Google Tasks): lists in a sidebar (All tasks side by side or one list; create, rename, delete with its tasks, whose upcoming occurrences leave the calendar at once; the default list kept), each list's tasks in their order with subtasks one level in, "Add a task" at the top (it stays open for the next one), edit in place (title, details, date and time or all day, deadline, repeat, star), add a subtask, drag to reorder, drag right to nest, Indent / Unindent / Move up / Move down / Move to another list (a repeating task stays in its list, as in Google Tasks), complete and reopen, a "Completed (n)" section, delete. As in Google Tasks, wherever a task is completed (Tasks, the calendar's details or check circle, Starred, or a linked Planner task with "complete in Google"), its subtasks are completed first, and reopening a subtask reopens the task it is under first, read from Google when its list is not loaded, so a completed task never has an open subtask. An edit is all or nothing: Google takes its fields (and a new list) first, and what the Planner keeps (time, deadline, repeat and the series' template, star) changes only once it has; an edit Google refuses changes nothing, here or in Google, and its form (the Tasks view's, the calendar's or a new task's) stays open with the error and what was typed, to save again. A list's menu sorts by My order, Date (past, each day, then no date) or Starred recently, and deletes all its completed tasks after asking. Starred lists the starred tasks of every list, the newest star first. A task's time (and end), deadline, repeat (Daily, Weekly on …, Monthly, Yearly, or Custom… with the events' rule builder; not for subtasks or tasks with subtasks) and star are kept in the Planner, as Google Tasks' API lets no other app set them; the form says so and links Google's reference. A repeating task's series keeps its own template (title, details, time, deadline and schedule): completing an occurrence, here or in Google (seen on a read), makes the next one from it in the same list, on the series' next date after the one it put this occurrence on, unless the series has it already (another window made it; a task that only shares the title and the date is never taken for it, and a task repeating in Google itself as well as in the Planner would get one from each); editing one asks This task (that occurrence alone, in Google and in the Planner; the series and its schedule stay) or All tasks (the series, then this occurrence to match; a new rule or date starts the schedule there; a new rule is for all), deleting one This task (the series goes on) or All future tasks; a series kept before templates takes its template from its open occurrence when first seen. As in Google Tasks, a repeating task has no subtasks and is none, and a task with subtasks does not repeat: Add a subtask, Indent and Repeat are unavailable there, with the reason, and a drag does not nest under it. Changes made in Google Tasks come in every two minutes and when the window comes back. Each task shows the Planner task planning it; plan it today or tomorrow from its menu, or drag it onto a day or the calendar. In Today's panel, a list's open tasks to plan as before. A linked task and its Google task stay in step both ways: title, details and date (the task's due date here), merged three ways against what both sides last agreed on (kept on the link): a field changed on one side takes that side's value; changed on both, the newer change wins (Google's `updated` against the Planner's last edit of that field, from the task's activity). The link follows its task to another list, moved here or in Google (a read finds it there; one Google gave a new id is found by what it last said); every write goes to the list the task is in now, a stale list is looked up once and the write retried there, and a write that still fails says so, with the Planner undoing a completion Google refused and marking a task Google no longer has. Completing or reopening it here does the same there (complete, ask or leave it); a completion in Google completes it here (setting); planning it on a day makes it due that day; add any task to Google Tasks from its detail. Home and Today show a linked task's kept time, deadline, repeat and star. |
| Gmail | Inbox, unread, starred or any Gmail search, a page at a time ("Load more messages"); a message becomes a task with its sender and snippet, linked back to the thread (read-only). |
| Agents | Assign a task to an agent, as in GitHub or Linear: "Assign to…" (task detail's Assignee, a card's menu, Agent on a Linear or GitHub issue row) with a search box, presets and OpenCode's agents in sections with avatars, the current assignees checked, arrows and Enter; typing a model's name offers an agent on that model, kept as a preset. The agents are OpenCode's primary agents (build, plan, and custom ones from its global config folder or the project's `.opencode/`), each on its own model, and the presets named in Settings → Agents (an agent and a model, such as "Build · Claude"). Each assignee is an OpenCode command, `oc-planner-<id>.md` in OpenCode's global `command/` folder, whose frontmatter names the agent and model and whose template is the arguments (a preset's stays with the preset; an agent's goes a few minutes after its last use, so OpenChamber's `/` menu does not keep one for every agent); the chat starts with `/oc-planner-<id> <instructions>`, so OpenCode switches to that agent and model (`` !` `` in the instructions is defused, as OpenCode runs it as shell). The assignee works in a new worktree on Linear's branch name or `planner/<title>` (made first, with an empty "Worktree for …" chat, so OpenCode has loaded the commands there before the first message) and is told to commit, push and open a pull request with `gh pr create` that links the issue; the run follows that pull request through gh and through the pull requests linked to the chat (Open, Draft, Merged, Closed), and a merged one offers to complete the task. The run keeps its assignee, shown on the card, in the task detail and on the Agents page, which filters by it. Or send a task to an agent (any assignee, or OpenChamber's default) in a project folder or a new or existing worktree; the task travels as a chip; runs show working, has a question, needs permission, ready for review, failed; Accept and complete is the user's call; Agents page; Work Status line; rail badge. From a chat: "Add to Planner" on a message, "Track chat in Planner", `/task`, `/today`. |
| Assistant | Ask Planner: the request and a compact plan go to the Small Model; known operations on known tasks only; preview, apply, undo. |
| Sync | Git remote for the data repository (a private GitHub repo or any git URL); sync after changes and every 5 minutes; Sync now. |

## Setup

1. Install the folder in OpenChamber and approve its access in Settings → Extensions:
   `sessions` and `prompt` (agents), `model` (summaries, Braindump, assistant), `service`
   (the local service; it may run `git`, `gh` and `opencode`), `network` (Linear).
2. Linear: Settings → Integrations → Linear in OpenChamber (or Connect in the Planner).
   The Planner never disconnects OpenChamber's Linear connection. Further workspaces:
   Planner → Settings → Linear → paste a personal API key (Linear → Settings → Security &
   access → Personal API keys). The key needs read access, and write access to move,
   create or edit issues and to comment.
3. Sync (optional): Settings → Sync → a remote such as `git@github.com:you/planner-data.git`.
   The service uses that machine's git credentials.
4. GitHub (optional): install `gh` on the machine running OpenChamber and `gh auth login`
   there (the dev container has `gh`: `docker exec -it oc-forge-openchamber-dev gh auth login`).
   A `GH_TOKEN` in OpenChamber's environment does not reach the service. Assigned agents
   open their pull requests with the same `gh`.
5. Agents (optional): Settings → Agents names presets of an OpenCode agent and a model. The
   service writes their commands into OpenCode's global config folder, `$XDG_CONFIG_HOME/opencode`
   or `~/.config/opencode` of the user running OpenChamber (the host passes the service only
   PATH and HOME); an OpenCode started with another config folder will not see them.
6. Google (optional): in a Google Cloud project, enable the Google Calendar, Google Tasks
   and Gmail APIs, set up the OAuth consent screen (yourself as a test user), and create an
   OAuth client ID of type Desktop app. Planner → Settings → Google: paste its ID and
   secret, then Connect a Google account with Calendar, Tasks and Gmail as wanted. Tick the
   calendars to show, and choose the one working sessions are written to.
7. AI features need a Small Model (a provider key, or Settings → Sessions → Small Model);
   without one they say so and the rest works.

## Limits of an OpenChamber extension

No mobile or VS Code surface, no tray, menu bar or global shortcut, no notifications when
no Planner surface is open, one integration slot (Linear; further Linear workspaces use API
keys, Google signs in through the service), no Outlook, Slack or Teams, Gmail read-only, no
team sharing. An extension cannot choose a chat's agent or model, so the Planner does it
through OpenCode commands; OpenChamber 2.5.2 sends a new chat's first message before
OpenCode has loaded the commands of a folder it has just started, so an assignment's new
worktree is made first, with an empty "Worktree for …" chat that the extension cannot
delete. The service cannot reach OpenChamber's own OpenCode server (it has a password), so
it can only ask OpenCode's background server, when one runs, whether a new command is
listed; otherwise it waits a moment.
Google's own APIs set further limits: Google Tasks' API keeps a task's date without a time
and has no deadline, repeat or star for other apps
(https://developers.google.com/workspace/tasks/reference/rest/v1/tasks), so the Planner keeps
those itself, in its event log by account and task id (following moves), shown on every
Planner surface but not in Google's own apps; nothing is written into a task's title or
details. A repeating series made in Google Tasks cannot be read either: its occurrences show
as single tasks. Google Calendar's appointment schedules and working location are not part
of the Planner; search covers the calendars shown.
Undo covers moving, resizing or deleting one event or occurrence (for ten minutes); a changed or deleted series has none.

## Develop

From `containers/openchamber-dev`:

```sh
docker compose exec -w /extensions/planner openchamber bun install
docker compose exec -w /extensions/planner openchamber bun run check   # tsc, strict
docker compose exec -w /extensions/planner openchamber bun test tests/
docker compose exec -w /extensions/planner openchamber sh -c 'LINEAR_SCHEMA=/tmp/linear-schema.graphql bun test tests/linear.test.ts'
docker compose exec -w /extensions/planner openchamber bun run build   # panel/main.js + service/main.js
node ../../extensions/planner/tests/e2e/run.mjs http://<bind>:35310     # on the host
node ../../extensions/planner/tests/e2e/sunsama.mjs                       # on the host, this checkout's build
node ../../extensions/planner/tests/e2e/linear.mjs /tmp/opencode/planner-linear  # the Linear page on this checkout's build (harness.mjs)
node ../../extensions/planner/tests/e2e/calendar.mjs /tmp/planner-calendar   # this build, a fake Google
node ../../extensions/planner/tests/e2e/agentpr.mjs http://<bind>:35310   # the installed extension, a real agent, a fake GitHub
```

`agentpr.mjs` assigns a task to OpenCode's build agent on the installed Planner, on
`AGENTPR_MODEL` (default `openai/gpt-6-luna`, through a preset it adds and removes; the
container's OpenCode needs a provider for it, see `containers/openchamber-dev/README.md`),
and follows it to a pull request: the agent commits in its new worktree, pushes, and runs
`gh pr create`; the service finds the pull request with `gh`, the task shows it, and a merge
offers to complete the task. Only GitHub is fake. `tests/e2e/fakeGithub.mjs` runs in the
container, and its `gh` (the agent's and the service's) reaches it through a Unix socket
(`http_unix_socket` in a `~/.config/gh` written for the run, with a fake token).
`planner-demo-a` gets an origin with two URLs:
- its fetch URL is `https://github.com/harness-org/planner-demo-a` (what `gh` reads);
- its push URL is the fake's git server (`git http-backend` over a bare repository).

The journey puts the container back as it was at the end.

`sunsama.mjs` runs this checkout's panel and a private copy of its service in the dev
container's OpenChamber (`tests/e2e/harness.mjs`): the sources panel, drags onto days and the
calendar, daily planning, the assignee picker, and two real chats in `planner-demo-a` as
OpenCode's read-only plan agent, through a command file it writes to the container
(`oc-planner-harness-plan.md`) and removes, with the chats and worktrees, at the end.

The built `panel/main.js` and `service/main.js` are committed so the folder installs
without a build. The repository's root `.gitignore` ignores `lib/`; this package's own
`.gitignore` re-includes `panel/lib/`. A manifest that changes capabilities or service
permissions needs approval again. The e2e journey cleans up before and after itself
(tasks, chats, worktrees, folders, calendars, the Linear page layout, the Google session
calendar) and mocks Linear and the Small Model at the host's routes, and a second Linear
workspace, Google and pull request lookups at the service's routes, so it never touches a
real Linear workspace or Google account. Its one real Linear call
sends a made-up key, to check that the service refuses a key Linear rejects.
