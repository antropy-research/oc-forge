# Planner extension

Sunsama's daily planning inside OpenChamber, with agents as part of the plan:
collect work, plan the day, focus or hand a task to an agent, answer its questions,
review the result, and close the day and the week. Built as an OpenChamber SDK
extension (manifest `apiVersion` 1; SDK 2.5.3, tested on OpenChamber 2.5.3, the latest
release, both as released and as oc-forge's adapted build; web and desktop).

Plan and progress live in the zmemory project: `.tasks/1024-planner-sunsama-features-plan.md`,
`.tasks/1025-planner-agents-md-requirements-plan.md` and
`02-draft/syncopation/2026-10-24-planner-sunsama-build-log.md`.

## Architecture

| Part | Path | Role |
|---|---|---|
| Domain | `src/domain/` | Types, events and validation, reducer, rollover, recurrence, scheduling (free slots, lanes, playlist), ICS parsing, Linear/GitHub mapping, agent runs, rituals, suggestions, Braindump and assistant parsing. Pure; shared by service and panel. |
| Service | `service/` → `service/main.js` | Local Node service the host starts on the first `serviceRequest`: validates commands, appends events, folds state, commits history, syncs with a git remote, fetches ICS feeds, reads GitHub through `gh` (issues, and the pull requests agents open), keeps the API keys of extra Linear workspaces and runs the Planner's Linear queries with them, signs in Google accounts (and tells a work or school account by Google's `hd`) and talks to Google Calendar, Google Tasks, Gmail and Drive (file names, to attach to a task), declines the meetings that overlap a Busy task set to decline them (`service/googleDecline.ts`), changes a repeating Google task's series (`service/googleSeries.ts`: its next occurrence, one upcoming occurrence changed or deleted alone, an edit of all its tasks or no repeat any more, This and following tasks or All tasks deleted, and its open task gone from Google; one change of a series at a time, whichever window asks, each worked out from the plan as it is when it is written), writes working sessions to Google Calendar (with the visibility of the Google task they plan), reads Pending tasks, gives Google Calendar's task notifications to the panel's surfaces, each once, finds OpenCode's agents (its config folders, and its running server when it is up) and models (`opencode models`), and writes one OpenCode command per agent a task can be assigned to. |
| Panel | `panel/` → `panel/main.js` | Preact UI bundled as a classic IIFE. One bundle serves the full page, the rail panel, the Work Status section and a hidden background frame (message actions and slash commands). Markdown is parsed with `marked`'s lexer and drawn as plain elements (`panel/lib/markdown.ts`): raw HTML stays text, only http(s) and mailto links, images become links, never `innerHTML`. |
| Tests | `tests/*.test.ts`, `tests/e2e/` | `bun test` for domain, service and panel helpers (Google writes through a mocked `fetch`, and the service run against `tests/e2e/fakeGoogle.mjs`); `fakeGithub.test.ts` runs the real `gh` against `tests/e2e/fakeGithub.mjs`. Playwright journeys against the dev container (`containers/openchamber-dev`): `run.mjs` and `agentpr.mjs` on the installed extension (`agentpr.mjs`: a real agent opens a pull request against the fake GitHub), and `harness.mjs` journeys on this checkout's build: `smoke.mjs`, `sunsama.mjs` (its GitHub, Gmail and meetings parts, against the fakes, run alone with `SUNSAMA_PARTS=github,gmail,meetings`; `github` needs the real `gh` as `GH_BIN`), `linear.mjs`, `calendar.mjs` and `tasks-calendar.mjs` (their service signed in to the fake Google; task notifications are off in a harness's plan unless a journey turns them on, as `tasks-calendar.mjs` does). |

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
| Tasks | Title, notes, subtasks (a subtask can become a task), planned and actual time, channel, priority, start (day or backlog bucket), due date, objective, folder, repeat, activity log, duplicate, archive, trash, undo (only of what nobody has changed since: see [The Planner's own Undo](#the-planners-own-undo)). A title, notes, planned time or subtask's title edited in place saves what changed from what it showed when editing began, over the task as it is then: one left as it was writes nothing (a change made in another window meanwhile shows), one changed in another window meanwhile too is asked about (Keep theirs, Save mine). Subtasks are ticked, added, renamed and deleted on the list as the plan has it then. When that can't be read, nothing is saved: a field keeps its edit and says it couldn't check, with Try again; a subtask change says so. |
| Add Task syntax | `~30m`, `@tomorrow` / `@fri` / `@oct 30` / `@backlog` / `@someday`, `#channel`, `!high`, `$objective`, `>Inbox triage` (Sunsama's `>`: the new task, or the item a pasted URL imports, merges into the open task whose title starts so, as a subtask; the field names that task); `A` opens the Add task window. A URL pasted alone is taken as Sunsama's [Add via URL](https://help.sunsama.com/docs/usage-guides/tasks/add-via-url) takes it, and the field says what Enter will do: a Linear issue, a GitHub issue or pull request and a Gmail message become a task linked to them, a Google Calendar event is added as "Add to tasks" adds it, any other page is a task with that page as its link; a pasted Linear issue shows its status, to change as it is added (see [Pasted URLs, source by source](#pasted-urls-source-by-source)). |
| Backlog | Six time buckets, folders, search, channel and context filters, Braindump (line by line, or organized by the Small Model and reviewed before adding). |
| Channels | Work and personal contexts; personal time stays out of the workload; filters; delete keeps tasks. |
| Workload | Planned time per day against a threshold; history-based estimate and channel suggestions; auto-sort; playlist times (when each open task would run in order). |
| Calendar | Laid out as Google Calendar: a rail with Create (an event or a task), the mini month and "My calendars" / "Other calendars" with colored checkboxes ("Display this only", a color); Today, the arrows, the range title and the view (Day, Week, Month, Year, Schedule; keys D, W, M, Y, 5, J, K; show weekends, declined events, completed tasks); search (`/`, the matching events of the calendars shown, a year back and two ahead, day by day as in Schedule); Settings (⚙) → Print, or Ctrl/⌘+P, Google Calendar's print preview of the range shown (see the inventory below); Calendar or Tasks. A newly connected account's own calendar shows at once, as in Google; shared ones wait to be ticked. Day and week grids with an all-day row of bars, each block's title wrapping over the lines its height allows with the time on its own line when there is room ("Title, 10am" on one line for short blocks; the full text in its label and tooltip); Month with bars, dotted timed events and "N more"; Schedule as Google's agenda. Click or drag on the grid (or click a month day) for quick create: an Event in a chosen Google calendar, or a Task, as in Google Calendar: one Google task on that day in a chosen list, at that time (kept in the Planner; with "The Planner only" a Planner task with a working session instead); "More options" opens the editor (times, all day, repeat presets and a custom rule, calendar, Google Meet, place, notifications, color, busy/free, visibility, description, guests). Click an event for its details (time, how it repeats, Meet, place, guests and their answers, description, notifications, calendar) with Edit, Delete, RSVP (Yes, No, Maybe), Sunsama's "Add to tasks" (also the grid's hover +: a task linked to the event, by its start time) and Options → Duplicate (the editor opens with a copy); guests are suggested from the account's Google Contacts (Settings → Google, "Contacts", asked for when first used). Drag Google events to move them and their bottom edge to resize them; a recurring event asks This event, This and following events or All events, an event with guests whether to email them; everything is written to Google Calendar, and a snackbar says so, with Undo after moving or resizing one event. Unanswered, maybe and declined invitations show as Google draws them. Working sessions as before: drop tasks to timebox, drag, resize, remove; moving a session moves its task; auto-schedule into free time; sessions written to a chosen Google calendar ("default for tasks") follow it both ways, and a channel's go to its own calendar when one is chosen (Sunsama's Timeboxing Channel). Meeting import, as Sunsama's: Settings → Meeting import (Show prompt or Auto-sync, the calendars to import from, the five exclusions, auto-complete, an import channel per calendar); daily planning's "Fill in calendar events"; a meeting's task is completed when its event ends. Google tasks with a date show on that day in the all-day row, or at their time in the grid with their check circle when they have one, completed ones struck through, planned ones marked and linked to their Planner task, a deadline flagged (red once passed) and shown on its own day in the all-day section as Google's flag (a task with only a deadline shows there alone; a timed task keeps its block and has its deadline there too, its own day included; an all-day task due on its deadline's day is one item, with its flag), and a repeating task's upcoming occurrences at their dates and times (lighter, with its repeat mark; the real one replaces each once Google has it, never two for one date; another task with the series' title on that date is a task of its own and shows beside it; their details show that task and how its series repeats, with Edit, asking This task or All tasks, and Delete, asking This task, This and following tasks or All tasks, as Google Calendar asks: This task edits that one alone in the calendar's task editor (its title, details, date, time and deadline; the series' repeat shown, locked) or deletes it, so its date shows nothing and the series goes on past it; an edited one shows its own values, a moved one on its new date, after a reload too; This and following tasks ends the series the day before it ("Daily, until …"), the open task and the upcoming ones before it staying as they were, also once those are done; All tasks edits the series, or deletes it with its completed tasks), in Day, Week, Month and Schedule, whenever an account with Tasks is connected; their details edit them (Edit opens the Tasks view's form over the calendar, which stays where it was: title, details, date and time, deadline, repeat, star and list; a repeating one asks This task or All tasks), complete, star, delete or plan them; dragging one to another day changes its date in Google (it keeps its time), dragging a timed one in the grid changes its time, and an all-day one dropped on the hours gets that time. Any event becomes a task on its day with its length as planned time; read-only ICS subscriptions (RRULE, EXDATE, overrides, time zones). Pending tasks, as in Google Calendar: today's all-day section (Day, Week, Month, Schedule) has "N pending tasks" for the open Google tasks dated in the past 365 days, which opens their list, latest first, each with its date, its time or All day, its repeat and its list; a row's circle completes it, Reschedule this task moves it to Today, Tomorrow or a date picked (Google's date; a time kept in the Planner stays) and Edit opens its editor; a task done or moved past yesterday leaves the list (read from every list with Tasks, without the completed ones; hidden with the Google tasks on the calendar). Task notifications, as Google Calendar gives them: at a task's time, at 9 AM for one with a date alone, and at 9 AM on its deadline's day to complete it (one due all day on its deadline's day gets that one alone), for the upcoming occurrences of a repeating task too, none for a time that had already passed when the task got it (Google sends none either). The Planner gives them itself, as OpenChamber notifications that stay until dismissed (OK), while one of its surfaces is open (the page, the rail panel or its Work Status section) in a window on screen: each once, to whichever surface or window asks first, and one missed while none was open comes when one opens, the same day; Settings → Google turns them off. Under "My calendars", Tasks has each task list as a row of its own, as Google Calendar lists them: a checkbox (its tasks on the calendar or not), "Display this only" and a color, which its tasks take on every view unless a task has its own (Advanced settings → its color: Google Calendar's eleven, or "List color"). A task's details show its color, its Drive attachments (each opens in Drive), "Do not disturb · Declines meetings" and the meetings declined for it. The rail and the unscheduled-tasks panel fold away when the week would get too narrow (the menu button and the panel button bring them back). |
| Time | One running timer, manual entries, actual vs planned, planned counts as actual (setting); a running-timer bar. |
| Rituals | Daily planning (5 steps, plans tomorrow after 3 PM; collects from the backlog, Linear, GitHub, Gmail, Google Tasks, meetings and objectives, and every add lands on the day being planned), daily shutdown, daily highlights (stars, custom items, AI summary, publish; Other activities, as Sunsama's: the day's tasks not among the highlights and the day's GitHub work, each with Include), weekly objectives, weekly planning (carry over), weekly review (progress, body of work, time by channel). |
| Rollover | At local midnight, with catch-up after downtime; rollover count; archive after N rollovers. |
| Recurrence | Daily, weekdays, every n weeks on chosen days, monthly (end-of-month aware), yearly; instances a week ahead; untouched instances give way to the next one; apply edits to upcoming; stop. |
| Stats | Completed tasks, actual time, actual vs planned, days planned, streak, work per day, time by channel. |
| Search & keys | Ctrl/Cmd+K palette (navigate, act, find any task, ask the assistant); `A`, `T`, `F`, `P`, `O`, and `C` / `Z` / `X` on the hovered card; on the Linear page, Linear's keys (`F` filters there, `[` folds its sidebar). |
| In OpenChamber | On oc-forge's adapted OpenChamber (`adapters/openchamber`; on a stock release these fall away): a Cmd/Ctrl+click or a middle click on a page, a task, a Linear issue or a task's chat opens it in a new browser tab, as on a link, while a plain click goes there in place; the page's address names where it is (`?extension=oc-forge-planner&route=/today?task=<id>`), so it can be reloaded, copied or opened from elsewhere; and OpenChamber's own keys (switching header tabs, chats and side panels, closing a tab, its sidebar and palette) work while the Planner has focus, except what the Planner uses itself: typing in a field, Cmd/Ctrl+K, and Cmd/Ctrl+B on the Linear page. |
| Linear | Several workspaces, shown merged or one at a time. A page laid out like Linear, with its own sidebar: My issues (Assigned, Created, Subscribed), Planned (the issues already in the plan), Favorites (views, projects and issues), every saved view by team and workspace (searchable; views of issues and of projects) and Projects; ↑/↓ and Enter, `/` to search (as one types), `G` then `I`, `V` or `P`, `[` to fold it away; it reopens where it was (kept on this device). Where the page is too narrow for it (1024 px with OpenChamber's sidebar open), the sidebar folds behind a toggle in the header and opens over the list, closing on Escape, a pick or a click outside; `[` puts the focus on the open section as the sidebar shows (beside the list or over it), so ↓ typed at once already moves through it; the header's search then takes `/`, and rows put properties that do not fit under the title. A saved view lists exactly the issues Linear lists for it: its own filter, what its display hides (completed issues by its window, sub-issues, triage) and every page (three at once, the rest on scroll or Load more, never a silent cap), opened with its layout, grouping, sub-grouping, ordering and properties (anything shown another way is named); a view of projects lists its projects. Filters as in Linear: Filter or `F` opens a searchable, keyboard-first menu (properties, then values with ticks; typing finds a value of any property; ↑/↓, Enter, Esc, Backspace back) of status, assignee, creator, priority, labels, content (the title or description contains, or does not contain, a text), project, milestone, team, cycle, estimate, subscribers, relations (blocked by, blocking, related, duplicate, a parent issue, sub-issues), the due, created, updated and completed dates, and the workspace ("Me" is whoever reads, in each workspace); chips such as "Status is either of Todo, In Progress" whose operator (is / is not; include any / all / none for labels, subscribers and relations; before / after a date, besides overdue, today, this week, next week, no due date, or a time ago; at least / at most for estimates) and values can be changed; "Match all / any" for the top-level filters; Advanced filter (in the menu) builds Linear's rows joined by and / or, and groups of them nested two deep, each switching between all and any; a group shows in the bar as "Any of 2 filters" and opens in the builder; Clear. A saved view opens with its own filter (its `filterData`) in the bar, an "or" as one group: while it holds as saved Linear applies it; changed here, the Planner asks for the view's team's issues with the filters as they are (Reset brings the view's back); parts the Planner cannot edit show in words and still apply. The choices come from the workspaces (every state, person, label, project, milestone, cycle and estimate scale; a team's view offers its team's), and the filters go to Linear as an `IssueFilter` with `and` and `or`, so the answer is complete. Display (`Shift V`): list or board (`Cmd/Ctrl B`), grouping and sub-grouping (status, assignee, project, priority, cycle, label, team, workspace), ordering (manual, status, priority, last updated, last created, due date, number) and its direction, completed issues (all, past day to past year, none), sub-issues, empty groups or columns, triage, and the properties rows show; a view's changes last while it is open, the Planner's own lists keep theirs. Status groups and board columns are the teams' exact workflow states in Linear's order (same-named states of several teams share one); dropping a card sets exactly that state, or the group's priority, assignee, project or cycle, in the card's own team, and a state its team lacks is refused. Projects: status, health, progress, lead, dates and teams; a project's issues as a full list (filters, display, board), its milestones, latest update and description. The issue view is laid out like Linear's: the title and Markdown description (Write / Preview, a formatting bar, Ctrl+B / Ctrl+I / Ctrl+Enter; checklist items ticked in place; a save that would overwrite a change made in Linear meanwhile asks first), sub-issues, the activity (history and Markdown comments), and a properties sidebar (status, priority, assignee, labels, project, cycle, estimate, due date; links) whose searchable menus open with `S`, `P`, `A`, `L` and `Shift D`; `J` / `K` move to the next or previous issue of the list, `Esc` closes the menu, then the issue; each change sends only that field. Plan by click or drag (also onto the calendar); completing asks (or always / never) to update the issue's status in Linear, any state of its team (Done picked first), and so does importing one when Settings → Linear says (Sunsama's import automation); optional move to In Progress when planned; optional completion import; create an issue from a task in any workspace's team; an agent's new worktree defaults to Linear's branch name for the issue. The panels beside Today, the calendar and planning keep a list of their own (my issues, a view or a search, with the same filters), as Sunsama's: My issues keep completed issues five days, "Show already imported", "Create a view in Linear" or "Edit view in Linear". Nothing is left out unsaid (round 12): projects and saved views read 500 and 1,000 at once, the rest with Load more projects and Load more views; an issue's team options (people, labels, projects, states, cycles) are read page by page past 250; filter menus, the issue page (labels, sub-issues, links, comments, activity), a project's milestones, favorites and the team picker say when Linear has more than they read (see [Sources' limits](#sources-limits-one-by-one)). |
| GitHub | Assigned issues, review requests, my open PRs (read-only, like Sunsama, whose GitHub integration lets you "Pull in GitHub issues, PRs into your task list"), 50 at a time in GitHub's order (updated, newest first): "Showing 50 of 51" and Load more, to "All N shown"; a search field narrows the list in GitHub's own syntax (words, `repo:owner/name`, `label:bug`), a Repository choice offers the repositories you work in, the latest first (Sunsama's "most relevant repositories"), and past GitHub's 1,000 results of a search the list says to narrow it; Refresh (↻) reads again as many as are shown, the rest still a Load more away. Plan and drag like Linear; linked items, every one of them (100 a call), keep their state and title. An issue's or a pull request's URL pasted into a new task imports it, as Sunsama does ("paste the URL of the issue into a new Sunsama task's title"), one in no list too. The day's work on GitHub (pull requests opened, reviewed and merged, comments, discussions) is in Daily highlights' Other activities, as Sunsama surfaces it in the end-of-day review (see [The end of the day, integration by integration](#the-end-of-the-day-integration-by-integration)). When `gh` is missing or not signed in, the source says so and where to run `gh auth login` (inside the container when OpenChamber runs in one). |
| Google Tasks | A Tasks view as the Google Tasks app (Calendar → Tasks, or Google → Google Tasks): lists in a sidebar (All tasks side by side or one list; create, rename, delete with its tasks, whose upcoming occurrences leave the calendar at once; the default list kept), each list's tasks in their order with subtasks one level in, "Add a task" at the top (it stays open for the next one), edit in place (title, details, date and time or all day, deadline, repeat, star, and Advanced settings: availability, Free or Busy, and visibility, Default visibility, Public or Private, which only a task with a time has, as in Google Calendar; Busy makes the Planner plan other work around the task, in Timebox automatically and the playlist times, and the visibility goes to the working sessions the Planner writes to Google Calendar for the task planning it, so Private shows them to others as busy, without their title; a repeating task's are its series', so changing them is for all its tasks), add a subtask, drag to reorder, drag right to nest, Indent / Unindent / Move up / Move down / Move to another list (a repeating task stays in its list, as in Google Tasks), complete and reopen, a "Completed (n)" section, delete, with Undo in the snackbar (and Ctrl/⌘+Z): Google undeletes the task and its subtasks and what the Planner kept for them comes back. What Undo gives back is read before the deletion from where it is kept, never from what the window happened to load: the task and its subtasks from Google (Google deletes them with it), what the Planner keeps for each from the service, so a task deleted from the calendar of a Planner just opened gets every subtask back, nested, as from the Tasks view; when that can't be read, nothing is deleted, and it says so, to try again; a subtask Google refuses to give back is said. A repeating task's is the service's, one change of the series at a time and against the series as it is then: a next occurrence the deletion made goes again while it is still as it was made (one edited or completed since stays, the task back beside it, and Undo says so), and a series deleted This and following or All tasks comes back with the rule and the changes the cut took, and whatever changed since. Completing a task says "Task completed" with Undo too (and Ctrl/⌘+Z), wherever it is completed, as Google Tasks and Google Calendar do: it is open again, its subtasks with it (read from Google as they are when it is completed, not from the window's copy), and for a repeating task the next one its completion made goes again under the same rule, the series going on from it. A task's form (in the Tasks view, over the calendar, Edit → All tasks, or one upcoming task) saves its change from what it showed when it opened, over the task, its series and Google's fields as they are then: a field it left alone keeps what another window, the service or Google's own apps gave it meanwhile (a time, a repeat cut short by This and following tasks, a title), and This task / All tasks is asked from the series as it is and from what the form changed (a new rule, or a series' own setting, is for all). A field the form changed that changed meanwhile too is not written: the form says so ("Time was changed to 1pm in another window (yours: 10am)") with Keep theirs and Save mine, and the save goes on with the choice. When the task can't be read as it is now (the plan, or the task in Google), unknown is never taken for unchanged: the form writes nothing, keeps the edit open and says it couldn't check for changes made elsewhere, with Try again; once the read works, a conflict is asked as above. One upcoming task deleted alone on the calendar is given back by Undo as the service had it when it was deleted, not as the window last saw it. Advanced settings also have the task's color, and for a work or school account (Google's `hd`; Google Calendar offers these to those alone, and the Planner shows them only there) Do not disturb (the Planner's own task notifications that come during the task wait until it ends; its own notification comes at its start; Google Chat, other apps and OpenChamber's own notifications can't be muted from an extension) and "Automatically decline meetings" (only when Busy, "Unavailable for "Free" time entries" otherwise, as Google says): New and existing meetings or Only new meeting invitations, with a message; the service answers the invitations on the account's own calendar that overlap the task (and its series' upcoming occurrences, two weeks ahead) "Declined" with that message, which Google sends the organizer, at once after a change and every five minutes, each invitation once (one the user answers again stays answered). "Add a Google Drive attachment" opens a Drive picker that searches the account's Drive by name (Drive asked for first, the way Calendar and Tasks were: a sign-in for what the account has plus Drive's read-only file names); Insert attaches the files chosen (at most 25), each opens in Drive or is removed ("Remove attachment"). Google Tasks' keyboard shortcuts work on the selected task (Up/Down, Home/End, Space completes, Ctrl/⌘+] and [ indent and unindent, Ctrl/⌘+Alt+Enter adds a subtask, Ctrl/⌘(+Shift)+Up/Down move up/down or to the top/bottom, s + = star, s - unstar, . and v open its menu, Enter in a title adds a task below), Ctrl/⌘+/ lists them. While focus is on a task in the Tasks view, Google Tasks' own shortcuts stay there, as VS Code keeps its keys (Ctrl/⌘+/ and Ctrl/⌘+Z anywhere in the Tasks view); Ctrl/⌘+[ and ] are also OpenChamber's history back and forward, which reach OpenChamber from everywhere else in the Planner. Ctrl/⌘+P prints the list anywhere in the Tasks view (Print list), and opens the print preview in the calendar, as Google Tasks and Google Calendar bind it; it is also OpenChamber's command palette, which it opens from everywhere else in the Planner. Lists go in the order the user puts them (drag one, or Alt+Up/Down), on the calendar too. A shared task (assigned in a Google Doc or a Chat space) says so and links back, and neither repeats nor takes subtasks, as in Google Tasks; a task made from an email or a Keep reminder says "From Gmail" or "From Keep" and links back. Gmail messages (Google → Gmail) have "Add to Tasks": a task in the default list with the email's address in its details (Google's own link back is read-only to other apps). As in Google Tasks, wherever a task is completed (Tasks, the calendar's details or check circle, Starred, or a linked Planner task with "complete in Google"), its subtasks are completed first, and reopening a subtask reopens the task it is under first, read from Google when its list is not loaded, so a completed task never has an open subtask. An edit is all or nothing: Google takes its fields (and a new list) first, and what the Planner keeps (time, deadline, repeat and the series' template, star) changes only once it has; an edit Google refuses changes nothing, here or in Google, and its form (the Tasks view's, the calendar's or a new task's) stays open with the error and what was typed, to save again. A list's menu sorts by My order, Date (past, each day, then no date), Deadline (past, each deadline, then no deadline), Starred recently or Title, and deletes all its completed tasks after asking. Starred lists the starred tasks of every list, Recently starred or by Date; "Add a starred task" adds one to the list chosen, and a starred task's form changes its list. A task's time (and end), deadline, repeat (Daily, Weekly on …, Monthly, Yearly, or Custom… with the events' rule builder; not for subtasks or tasks with subtasks), star, color, attachments, availability, visibility, Do not disturb and declining are kept in the Planner, as Google Tasks' API lets no other app set them; the form says so and links Google's reference. A series' template carries them; its color, Do not disturb and declining are the series' (changing them is for all its tasks, as availability and visibility are), its attachments this task's or, with All tasks, the series'; an upcoming task's own attachments too (This task on the calendar), kept with the series for that day and given to the task the series makes there, as its title and time are. All tasks changes, of these as of the rest, only what the edit changed, over the series as it is then. A repeating task's series keeps its own template (title, details, time, deadline and schedule): completing an occurrence, here or in Google (seen on a read), makes the next one from it in the same list, on the series' next date after the one it put this occurrence on, unless the series has it already (a task that only shares the title and the date is never taken for it, and a task repeating in Google itself as well as in the Planner would get one from each). The service makes it, for every window of its OpenChamber at once: it changes one series at a time and keeps the next occurrence's link in the same step as it makes it, so two windows completing (or deleting) the same occurrence at the same moment make one between them, the second window getting the first one's, and a window asking again later gets that one too. Every other change of a series goes through the service the same way, worked out from the series as it is when it is written, never from what a window last saw: what a task is made with is worked out again once Google has made it (a change written meanwhile, by a window not reloaded since an update or a sync, goes to Google too, and a task the series no longer wants is deleted again), so an edit saved in one window while another completes the occurrence before it is kept, and the one next task carries it. An occurrence is told by the date its series puts it on, not by the date it shows on: one moved alone (This task) onto another occurrence's day shows beside that one, in Day, Week and Month, as two tasks of a series do in Google Calendar, and completing or deleting either makes the next one by its own date and leaves the other as it is. Editing one asks This task (that occurrence alone, in Google and in the Planner; the series and its schedule stay) or All tasks (the series, then this occurrence to match; a new rule or date starts the schedule there; a new rule is for all), as Google Calendar asks; deleting one asks This task (the series goes on), This and following tasks (the series ends the day before it, by the date the series put it on: the tasks before it, open, completed or upcoming, stay as they were, and none is made from that day on) or All tasks (the series goes, its completed tasks too, deleted in Google a few seconds on when there are many), as Google Calendar asks; the service does the last two the same way, one change of the series at a time. Deleting This task is all or nothing too: the series makes its next one first (from its template, on its next date, with what is kept for it), and only then is this one deleted in Google; when Google refuses the next one nothing is deleted and the series stays as it was, to delete again (a completed one whose next Google refused is made on the next read, its series kept meanwhile), and when Google refuses the delete once the next one is made, both stay and the Planner says so, as the delete may have reached Google: deleting it again finishes, with no second next one. Its upcoming occurrences changed or deleted alone on the calendar (This task) are kept with the series as its template is, by the date the series puts each on, and carried from one occurrence to the next: the series passes over a deleted date and makes an edited one with its own title, details, date, time and deadline. An edit puts what it changed over the occurrence as it is then, so two windows editing one keep what each changed (the same field changed in both is asked about, as in a task's form), and one deleted meanwhile stays deleted; one the series has made meanwhile is changed as that task, in Google too (deleted, its next one is made first); a date the series no longer puts one on (cut by This and following tasks, or off a new rule) is refused. All tasks keeps them (an edited one keeps what it changed and takes the rest), and changes what the edit changed over the series as it is then (a rule it left alone stays, with an end This and following tasks gave it meanwhile); a new rule or start drops those no longer on its schedule; when the task it was made from was completed meanwhile, the edit is for the series from its next task on, which takes the new title and details in Google; a series kept before templates takes its template from its open occurrence when first seen (written by the window that sees it first; were its next task linked in another window at that moment, the next completion finds that task again rather than making another). A series' open task deleted in Google's own apps is taken as This task deleted there, once a full read of its list no longer has it: the series goes on from its next one; one moved to another list there is followed. A next task made, or one changed, in another window or by the service shows on this window's calendar once it has the plan (it looks every 5 s), Google's tasks read again then. As in Google Tasks, a repeating task has no subtasks and is none, and a task with subtasks does not repeat: Add a subtask, Indent and Repeat are unavailable there, with the reason, and a drag does not nest under it. Changes made in Google Tasks come in every two minutes and when the window comes back. Each task shows the Planner task planning it; plan it today or tomorrow from its menu, or drag it onto a day or the calendar. In Today's panel, a list's open tasks to plan as before. A linked task and its Google task stay in step both ways: title, details and date (the task's due date here), merged three ways against what both sides last agreed on (kept on the link): a field changed on one side takes that side's value; changed on both, the newer change wins (Google's `updated` against the Planner's last edit of that field, from the task's activity; when that can't be read, the task waits for the next sync rather than a guess). The link follows its task to another list, moved here or in Google (a read finds it there; one Google gave a new id is found by what it last said); every write goes to the list the task is in now, a stale list is looked up once and the write retried there, and a write that still fails says so, with the Planner undoing a completion Google refused and marking a task Google no longer has (only once every list could be read to look for it under a new id). Completing or reopening it here does the same there (complete, ask or leave it); a completion in Google completes it here (setting); planning it on a day makes it due that day; add any task to Google Tasks from its detail. Home and Today show a linked task's kept time, deadline, repeat and star. |
| Gmail | As Sunsama's Gmail integration: the panel (Shift G) shows a label at a time (Cmd/Ctrl adds one; an email must have each shown), with filters for Archived, Spam and Trash, and Already imported (all off at first), and a search; a page at a time ("Load more messages"); a message becomes a task with its sender and snippet, linked back to the thread; so does a message's address pasted into a new task, where Gmail's address names the message (see below). The task embeds the thread (browse, collapse) with Open in Gmail (S), Archive, Move to trash and Mark as unread, done in Gmail once the account allows "Gmail actions" (gmail.modify; asked for when first used). Settings → Gmail: import and completion automations (Mark as read or unread, Archive, Move to trash, Star, Unstar, Apply or Remove a label), or Show prompt to choose email by email; the custom email client (Gmail or Superhuman). Re-add Gmail account when Google stops accepting the access. |
| Agents | Assign a task to an agent, as in GitHub or Linear: "Assign to…" (task detail's Assignee, a card's menu, Agent on a Linear or GitHub issue row) with a search box, presets and OpenCode's agents in sections with avatars, the current assignees checked, arrows and Enter; typing a model's name offers an agent on that model, kept as a preset. The agents are OpenCode's primary agents (build, plan, and custom ones from its global config folder or the project's `.opencode/`), each on its own model, and the presets named in Settings → Agents (an agent and a model, such as "Build · Claude"). Each assignee is an OpenCode command, `oc-planner-<id>.md` in OpenCode's global `command/` folder, whose frontmatter names the agent and model and whose template is the arguments (a preset's stays with the preset; an agent's goes a few minutes after its last use, so OpenChamber's `/` menu does not keep one for every agent); the chat starts with `/oc-planner-<id> <instructions>`, so OpenCode switches to that agent and model (`` !` `` in the instructions is defused, as OpenCode runs it as shell). The assignee works in a new worktree on Linear's branch name or `planner/<title>` (made first, with an empty "Worktree for …" chat, so OpenCode has loaded the commands there before the first message) and is told to commit, push and open a pull request with `gh pr create` that links the issue; the run follows that pull request through gh and through the pull requests linked to the chat (Open, Draft, Merged, Closed), and a merged one offers to complete the task. The run keeps its assignee, shown on the card, in the task detail and on the Agents page, which filters by it. Or send a task to an agent (any assignee, or OpenChamber's default) in a project folder or a new or existing worktree; the task travels as a chip; runs show working, has a question, needs permission, ready for review, failed; Accept and complete is the user's call; Agents page; Work Status line; rail badge. From a chat: "Add to Planner" on a message, "Track chat in Planner", `/task`, `/today`. |
| Assistant | Ask Planner: the request and a compact plan go to the Small Model; known operations on known tasks only; preview, apply, undo. |
| Sync | Git remote for the data repository (a private GitHub repo or any git URL); sync after changes and every 5 minutes; Sync now. |

## The Planner's own Undo

An action on the Planner's own tasks, objectives, rituals and working sessions shows "… · Undo" for
eight seconds. The service keeps, for each such batch (named by its first command), what takes it
back, computed against the plan just before it, and the plan just after it (`service/planner.ts`,
`POST /commands` with `undo: true`). Undo (`POST /undo`) runs that against the plan as it is then,
and only if nothing it would change was changed since by someone else (`changedSince` in
`src/domain/undo.ts`): a field counts when the Undo would change it now and it no longer has the
value the action left. Otherwise nothing is written, the other window's change stays, the window
takes the plan as it is, and the toast says "Changed in another window since; not undone".

1. Only what the Undo puts back counts. A task moved, then renamed in another window, is moved
   back with their title.
2. An Undo that deletes something (taking back a creation, a session) counts all of it. A task
   renamed elsewhere since it was added is not deleted.
3. What the Planner keeps in step itself is not a change:
   - a source's state, and a linked task's due date, from the Linear, GitHub and Google syncs;
   - a working session's Google Calendar event, which the service writes and links;
   - when a record was last touched.
4. One that can no longer be done counts as changed too, for example a session deleted since.
5. The window's own later change to the same thing ends its Undo, so the toast never blames
   another window. A later change to something else, or a sync, does not.
6. The service keeps an Undo once, for a minute. Afterwards it says "This can no longer be undone".

| Undo (toast) | Offered from | Takes back | Not undone when, since, elsewhere |
|---|---|---|---|
| Task moved, Moved to today / tomorrow / next week / the next day / backlog | A task's menu, details, Z (backlog), Daily planning and shutdown, the archive, a drop on the calendar's all-day row or a month day | Its day or bucket and place; the working sessions the move dropped from its day, and its planned time; its folder; the archive | It was moved, reordered, archived or timeboxed on its new day |
| List sorted | A day's sort, Sort today by priority | Each task's place | Any of them was moved |
| Task archived | A task's menu, details, Daily planning and shutdown | Out of the archive | It was deleted |
| Task deleted | A task's menu, details, the archive | Back (into the archive if it was there) | It was restored elsewhere and archived or deleted again |
| Task restored | The archive | Back into the archive or the trash | It was archived or deleted again |
| Task completed | Focus | Open again | It was reopened and completed again |
| Task added, Task added from the calendar, Task duplicated, Added n tasks, Planned … (a Linear or GitHub issue, a Google task, an email) | Add task, the calendar, Duplicate, Braindump, the sources panel and drops | Deleted (a source already planned: moved back) | Anything of it was changed (a source's own sync aside) |
| Subtask became a task | Details | The new task deleted, the subtask back | The parent's subtasks changed |
| Estimates filled | Daily planning | Each planned time | One of them changed |
| Link removed, Added to Google Tasks | Linear, GitHub and Google panels | The link as it was | It was linked to something else |
| Timeboxed | A drop on the calendar, Timebox automatically | The session deleted; the task's day and planned time | The session was moved, or the task moved |
| Session moved, Session resized | Dragging a session on the calendar | Its time; the task's day and planned time | It was moved again, deleted, or its task moved |
| Session removed | A session's × on the calendar (Remove working session) | The session back; the task's day and planned time | Its task was moved |
| Objective deleted | Weekly planning | The objective back, and the tasks aligned with it aligned again | One of them was aligned elsewhere |
| Assistant made n changes | Ask Planner | Each of its changes, as above | Any of them, as above |

No Undo is offered for:

- starting and stopping a timer;
- logging or deleting time;
- saving a ritual's fields;
- adding, editing or completing an objective;
- settings (saving an agent preset asks for one, but a settings change has none).

Completing, archiving or deleting a task stops its timer: the time tracked stays as an entry,
and Undo does not start the timer again.

Google's own Undos (the Tasks view, Google Calendar's events and tasks) are Google's, described
below.

## Google's task help, operation by operation

Every operation Google documents for tasks in Google Calendar
([9901136](https://support.google.com/calendar/answer/9901136)) and in the Google Tasks help
pages it and Google Tasks' help centre link (read 2026-10-29), and where the Planner has it.
"Done" were there before round 10, "Done now" came with it; N/A is either a surface OpenChamber
does not have or a Google product the Planner is not. Journeys run at 1440x900 and 1024x768:
`calendar.mjs` (C), `tasks-calendar.mjs` (TC: `tasks`, `advanced` for a work account,
`inventory`, and since round 11 `print` and `decline`); unit tests in `tests/`.

| Operation (Google's help page) | Status | Where in the Planner | Checked by |
|---|---|---|---|
| Create a task from an empty slot or Create → Task, then Save (9901136, 7675838) | Done | Calendar quick create and rail Create → Task, in a chosen list | C |
| Task settings: start date and time, how long (end time), "Add time" (9901136) | Done | Task form: Date, Time, End time (none for a repeating task) | C, TC tasks |
| Deadline, in the All day section (9901136) | Done | Task form: Deadline; the flag on its day | C |
| Description; task list (9901136) | Done | Task form: Details; List (a repeating task stays in its own) | C |
| Advanced settings: change the color of your tasks (9901136) | Done now | Task form → Advanced settings → Task color (Google's eleven or List color); each list's color under My calendars | TC advanced, `taskAdvanced.test.ts` |
| Advanced settings: Free or Busy; visibility (9901136) | Done | Availability, Visibility | TC tasks |
| Advanced settings: Do not disturb, work or school accounts only (9901136) | Done now | Do not disturb (the Planner's own notifications wait until the task ends) | TC advanced, `taskAdvanced.test.ts` |
| Advanced settings: Automatically decline meetings if Busy, work or school only (9901136) | Done now | Automatically decline meetings: new and existing or only new, a message; declined in Google Calendar. Every time of every such task in the two weeks ahead is matched against one paged read of the account's calendar per pass (round 11: a pass used to look at the first 40 times alone); a pass that reaches a bound (4 pages of 2,500 events, 5 s) carries on a few seconds later from where it stopped, and the toast and the task's details say from where | TC advanced (three daily series, 45 times), `taskAdvanced.test.ts` |
| Tasks in Calendar: Create, Add a task (9901136) | Done | Calendar → Tasks (or Google → Google Tasks) | C |
| Mark a task complete (circle; Mark completed) (9901136, 7675838) | Done | Check circle on the grid and in lists; details → Mark completed; "Task completed" with Undo (and Ctrl/⌘+Z), as Google Tasks and Google Calendar say it: open again, and a repeating task's next one taken back while untouched (the service's, `GoogleSeries.uncomplete`) | C, TC tasks, `gtaskSeries.test.ts`, `tasksInventory.test.ts` |
| View tasks: My calendars → Tasks checked (9901136) | Done | Rail → Tasks; each list's own checkbox now too | C, TC advanced |
| Edit a task (Edit task → Save) (9901136) | Done | Details → Edit task; the save is the form's change from what it showed, a field changed meanwhile in another window asked about (Keep theirs, Save mine) | C, TC, `gtaskForm.test.ts`, `gtaskSeries.test.ts`, `googleService.test.ts` |
| Change the date/time of the next repeating task; edit all tasks (9901136, 12132599) | Done | Edit → This task / All tasks, asked from the series as it is when saved: a form open while the series changed (a new time, a cut) keeps those | C |
| Edit a deadline; edit start and end time (9901136) | Done | Task form | C |
| Delete a task (9901136, 7675838, 7675690) | Done | Details → Delete, a row's menu → Delete | C |
| Delete → Undo (7675690) | Done now | The snackbar's Undo, and Ctrl/⌘+Z: Google undeletes it with its subtasks, kept fields come back, from the calendar of a Planner just opened too (its subtasks read from Google before the deletion); a repeating task's through the service, against the series as it is then (`GoogleSeries.undo`) | TC inventory, C, `tasksInventory.test.ts`, `gtaskSeries.test.ts`, `googleService.test.ts` |
| Add an attachment: Drive, Insert; open, remove; at most 25 (9901136, 17017692) | Done now | Task form → Add a Google Drive attachment → Insert; Open; Remove attachment | TC advanced, `taskAdvanced.test.ts` |
| Hide completed tasks (Show completed tasks); hide all tasks (9901136) | Done | View menu → Show completed tasks; rail → Tasks | TC inventory |
| Pending tasks: edit, complete, reschedule (9901136, 7675629) | Done | Today's "N pending tasks" | TC tasks |
| Task notifications: at its time, 9 AM without one, 9 AM on its deadline (9901136, 7675838) | Done | OpenChamber notifications from the Planner | TC tasks |
| Turn on task notifications (13486720) | Done | Settings → Google → Task notifications; rail → Tasks | TC tasks |
| Repeat: presets, Custom (every n days/weeks/months/years; ends never, on, after) (12132599) | Done | Task form → Repeat | C |
| Subtasks, tasks with subtasks and shared tasks can't repeat (12132599, 11549608) | Done (shared: done now) | Repeat unavailable, with the reason | C, TC inventory |
| Recurring tasks can't move to another list (12132599, 7675629) | Done | List locked, Move to … unavailable | C |
| Stop repeating; a new repeat is a new series (12132599) | Done | Repeat → Does not repeat | `gtaskSync.test.ts` |
| Complete a repeating task: the next one appears (12132599) | Done | The service makes it, once for every window | C, `gtaskSeries.test.ts` |
| Delete This task / This and following tasks / All tasks (12132599) | Done | Delete asks, as Google Calendar | C |
| Upcoming instances of a repeating task on the grid (9901136, 12132599) | Done | Lighter items at their dates | C |
| Add a subtask (Task options → Add a subtask) (7675838) | Done | Row menu, form | C |
| Move a task to another list (Task options; drag) (7675838, 7675629) | Done | Row menu → Move to …; drag between lists | C |
| Delete all completed tasks (7675838, 7675690) | Done | List options | C |
| Sort by My order, Date ("Past" first) (7675629) | Done | List options → Sort by | C |
| Sort by Deadline, Title (7675629) | Done now | List options → Sort by | TC inventory, `tasksInventory.test.ts` |
| Sort by Starred recently (7675629) | Done | List options → Sort by | TC inventory |
| Reorder tasks (drag in My order) (7675629) | Done | Drag; drag right nests | C |
| Reorder task lists (drag; Alt+Up/Down) (7675629, 7675771) | Done now | Tasks sidebar: drag, Alt+Up/Down (kept in the Planner) | TC inventory |
| Find or hide completed tasks (Completed) (7675629) | Done | "Completed (n)" | C |
| Create, switch, rename, delete a list (7675771, 7675690) | Done | Tasks sidebar, List options | C |
| Add or remove a star; Starred list (12718779) | Done | Star; Starred | C |
| From Starred, create a starred task in its primary list (12718779) | Done now | Starred → Add a starred task → its list | TC inventory |
| Sort Starred by Date or Recently starred (12718779) | Done now | Starred options | TC inventory |
| Change a starred task's primary list (12718779) | Done now | Its form → List | TC inventory |
| Keyboard shortcuts: Enter, Space, indent, unindent, sub-item, finish editing, more actions, move up/down/top/bottom, star, unstar, select first/last, list of shortcuts, Undo (7675630) | Done now | Tasks view, on the selected task (kept from OpenChamber only while a task has the focus; Ctrl/⌘+[ and ] are OpenChamber's history keys elsewhere); Ctrl/⌘+/ | TC inventory, `tasksInventory.test.ts`, `forge.test.ts` |
| Shortcut: Print (Ctrl/⌘+P); Print list (7675630, 12298851); and Google Calendar's Print (41067) | Done now (round 11) | List options → Print list, and Ctrl/⌘+P in the Tasks view (the list the focus is in, else the one shown; Starred too): the browser's print dialog for the Planner's frame, which prints a sheet of that list alone: its title, its open tasks in its order (as sorted) with subtasks indented, each with its date and time, repeat, deadline, star and details, and its completed tasks while Completed is open (as Google's help says), pages breaking between tasks, in OpenChamber's light colors. It needs oc-forge's host, which gives the Planner's frames `allow-modals` (`"ocForge": { "modals": true }`); elsewhere Print list is disabled and Ctrl/⌘+P says "Printing needs OpenChamber with oc-forge's host". Google Calendar's Print: Settings (⚙) → Print, or Ctrl/⌘+P in the calendar, opens the Print preview of the range shown (Day, Week, Month, Schedule; a Year as its months) beside the page as it will print, with Google's options: Print range, View, Font size, Orientation, Color & style (Full color, Outline, Black and white), Show weekends, Show events you have declined, and in Schedule Print descriptions and Print your response; the printout has the range's events, tasks (deadlines, upcoming occurrences, Pending tasks) and working sessions | TC print (both sizes), `print.test.ts`, `forge.test.ts` |
| Report an assigned task as spam (`!`) (13012543) | N/A | Google's shared-task surfaces (Docs, a Chat space) report it; Google Tasks' API has no report | `TASK_SHORTCUTS` says so |
| Shared tasks: in your list, edit, delete, move (11549608) | Done | They are Google tasks; now say "Assigned in Google Docs / a Chat space" with the link | TC inventory |
| Shared tasks take no subtasks (11549608) | Done now | Add subtask and nesting unavailable, with the reason | TC inventory |
| Assign tasks in a Chat space or a Doc (`@task`); their notifications (9920628, 12048749, 11549608) | N/A | Google Chat and Google Docs | |
| Create a task from Gmail: Add to Tasks (7675838) | Done now | Google → Gmail → Add to Tasks | TC inventory, `tasksInventory.test.ts` |
| A task from Gmail or Keep links back ("From Keep") (7675838, 16540694) | Done now | "From Gmail: …", "From Keep" on the task | TC inventory, `tasksInventory.test.ts` |
| Create a task from a Chat message (7675838, 9920628) | N/A | Google Chat | |
| Tasks in the side panel of Gmail, Calendar, Chat, Drive, Docs (7675772, 7675838, 106237) | N/A | Those products' side panels; in OpenChamber the Planner's page and its Today panel have Google Tasks | |
| Tasks app on Android or iOS; home screen widget (7675772, 10478781) | N/A | No such surface in OpenChamber | |
| Keep reminders migrated to Tasks (16540694) | Done | They are Google tasks, edited and completed as any | |
| Dark theme (14286238) | Done | Follows OpenChamber's theme | |
| Limits: 100,000 tasks, 20,000 open per list; repeat at most every 1000 units (7675838, 16540694) | N/A | Google's own limits, enforced by Google (the Planner reads up to 4,000 open tasks of a list and says when there are more) | |
| Work or school accounts: the administrator turns Tasks and Drive on (7675772, 17017692) | N/A | Google Workspace's admin console | |

## Google's limits, one by one

Round 11 went through every place the Planner stops reading or writing Google before the end,
so that none leaves something out without saying so (review 10 found declining meetings
looking at the first 40 task times alone). Each is now complete, says so, or is Google's own.

| Where | Bound | When it is reached |
|---|---|---|
| Declining meetings (`service/googleDecline.ts`) | One read of the account's calendar per pass over all the times, 4 pages of 2,500 events and 5 s of declining a pass | The next pass carries on from that page or that meeting, 5 s later; the toast and the task's details say "still going through your meetings from …" (`taskAdvanced.test.ts`) |
| Declining meetings: how far ahead | Two weeks of a task's times | A later time is declined once it comes within the two weeks; the task form's note says so. Reading a repeating task's every future time every five minutes would read the whole calendar |
| Google Calendar's events of a range; calendar list; a series' occurrences before one | 8 pages of 2,500 events; 10 pages of 250 calendars; 8 pages of 2,500 | An error says the Planner reads at most that many |
| Event search (`/`) | A year back and two ahead; 2 pages of 250 per calendar | The results say the range; "Google found more than this; add a word" |
| Google Tasks: lists, a list's open tasks, tasks due in a range | 5 pages of 1,000 lists; 40 pages of 100 tasks; 20 pages of 100 a list | An error says the Planner reads at most that many |
| Google Tasks: a list with its completed tasks (Tasks view, printing) | 40 pages of 100 | The list says "This list is longer than the Planner reads at once; Google Tasks shows the rest"; its printout says so too |
| Pending tasks | The past 365 days | Google Calendar's own: "all uncompleted tasks from the last 365 days" (9901136); the entry says so |
| Task notifications | Today's, and yesterday's held past midnight by Do not disturb | Google Calendar's web notifications come while it is open; one missed while no Planner surface was open comes the same day. Round 11: one Do not disturb held to midnight came on no day; it now comes just after midnight (`taskAdvanced.test.ts`) |
| Task notifications shown at once | 3 | The rest are counted: "N more task notifications today: see the Planner's calendar" |
| Gmail search | 25 a page | More loads the next page, until Gmail has none |
| Drive search (Add a Google Drive attachment) | 30 a page | Round 11: More files loads the next page, until Drive has none (it used to stop at 30 silently) |
| Working sessions moved or deleted in Google | 10 missing events looked up a read | Round 11: the ones looked up longest ago go first, so each has its turn (ten that failed used to keep the rest from ever being looked up) (`googleTimeboxes.test.ts`) |
| A task's links from Google (From Gmail, From Keep) | 10 | Google gives a task one link, to where it came from |
| Attachments, notes, titles, a series' changed tasks | 25 files; 8,192 and 1,024 characters; 200 | Google's own limits for an event's attachments and a task's text, and a bound on what a series keeps; refused with the reason |

## Sources' limits, one by one

Round 12 did for every other source what round 11 did for Google, after review 11 found the GitHub
source stopping at its first 50 issues without a word (a single search page with no cursor; Refresh
asked for the same page again): every `first:`, `limit` and `slice` of a source panel, an import
path or a source's Refresh. Each now reads to the end, has a Load more, says so, or is the
source's own limit. Checked by `github.test.ts`, `fakeGithub.test.ts` (the real `gh` against the
fake GitHub), `linearStore.test.ts`, `pastedUrl.test.ts` and `sunsama.mjs` (its GitHub part, at
1440 and 1024, through the real `gh`).

| Source: where | Bound | Before round 12 | Now |
|---|---|---|---|
| GitHub: the source's lists (`service/github.ts` `list`) | Pages of 50 | One page of 50, no cursor: issue 51 unreachable; Refresh read the same page | GitHub's cursor (`pageInfo`, `after`) and its count (`issueCount`): "Showing 50 of 51", Load more, "All N shown"; a search field (GitHub's syntax, sent with the list's own qualifiers); Refresh reads again as many pages as are shown |
| GitHub: one search | 1,000 results | Not said | GitHub's own limit for a search: past it the list says to narrow it with words or `repo:owner/name` |
| GitHub: linked items kept current (`items`, `/github/items`) | 100 ids a call | The first 100 alone (`ids.slice(0, 100)`); and one deleted issue stopped every update, as `gh api graphql` exits 1 when GitHub answers errors beside data | All, 100 a call (GitHub's `nodes(ids:)` limit); the route refuses more than 100 instead of cutting; an answer with data is taken despite errors |
| GitHub: an agent run's pull request (`/github/pulls`, `gh pr list --head`) | 4 runs a request; a branch's 10 newest | The route cut a longer request to 4 | The panel sends 4 at a time, and the route now refuses more. A branch's 10 newest pull requests: GitHub keeps one open pull request per branch and base, and the newest come first |
| Linear: issue lists (My issues, views, search, Planned) | 3 pages at once (100, search 50) | Done before: the rest on scroll or Load more; Refresh re-reads as many pages as are shown | The same |
| Linear: linked issues kept current | 100 ids a call | Done before: all, 100 a call | The same |
| Linear: Projects | 10 pages of 50 | The rest unsaid | Load more projects; the count says "500+" |
| Linear: saved views in the sidebar | 10 pages of 100 | The rest unsaid | Load more views (a favorite of a view not read yet stays, and shows when it comes) |
| Linear: favorites | 10 pages of 250 | The first 250, no cursor | Paged; past 2,500 the sidebar says Linear has more |
| Linear: the team picker (Create Linear issue) | 20 pages of 100 | The first 100 teams, no cursor | Paged; past 2,000 it says Linear has more teams |
| Linear: an issue's options in the issue page (states, people, labels, cycles, projects) | 250 a page (cycles 25, projects and states 100 at first) | The first page of each, no cursor: a team's 251st person could not be assigned | The rest of each, page by page with the same filters (`teamOptionPageQuery`, `WORKSPACE_LABELS_QUERY`), up to 20 more pages each |
| Linear: filter menus' values (catalogs) | 20 pages (250; teams 50); a team's first 50 states | The rest unsaid | The menu of that property says "Linear has more … than this menu lists; a view saved in Linear filters by any of them" |
| Linear: an issue's page (labels, sub-issues, links, comments, activity) | 25, 50, 25, 100, 50 | The rest unsaid | Read with the issue in one request (Linear's complexity limit bounds it); "Linear has more comments, activity than shown here: Open in Linear ↗" when it has |
| Linear: a project's milestones | 100 | 25, the rest unsaid | Says so, with Open in Linear |
| Linear: a project's teams; an issue's labels on a list row | 10; 25 | Display | Display only: label edits add and remove a label by its id, so one past 25 is never dropped, and the issue's page says it has more |
| Gmail: a search | 25 a page | Done before: Load more messages | The same; a pasted message address is looked up in each account |
| GitHub: the day's work in Daily highlights (`service/githubActivity.ts`) | 50 a page of each source; 10 more pages each | New in round 12 | Read to the end of the day; past 10 more pages a source says "GitHub has more … than the Planner read (N in all): see the rest on GitHub", a link to GitHub's own search for it |
| Google Calendar, Google Tasks | | Round 11 | [Google's limits, one by one](#googles-limits-one-by-one) |
| Daily planning's sources | | | The same panels as the board's (Linear, GitHub, Gmail, Google Tasks), so the same paging; its meetings are the day's events |

## A read that a newer one overtakes

Review 12 found GitHub's Load more stuck: with page two on its way, another search showed its own first page, but the
list stayed "Showing 50 of 101 / Loading…", disabled, and Refresh did not help. The superseded Load more returned
without clearing its flag, and nothing else cleared it. Every read that a newer one can overtake was audited for the
same thing. The rule now: an older answer, or its error, never shows over a newer one's; nothing is left loading; and
a Load more button says "Loading…" while any read of its list is under way.

| Read | Before | Now | Checked by |
|---|---|---|---|
| GitHub: the source's list, and its Load more (`panel/lib/github.ts`) | Another search, repository or list kind, or Refresh, during a Load more: "Loading…" for good. During a Refresh the button said Load more and did nothing. The 5-minute refresh could drop a Load more the user asked for | Another list (`replace`) or Refresh drops what was under way for the one before, its Load more flag with it; a late page changes nothing. The 5-minute refresh waits for a Load more | `github.test.ts` (each change, the old page answering before and after the new one, an old error, Load more during a Refresh, the 5-minute refresh); `sunsama.mjs`'s GitHub part at 1440 and 1024: each change during a held Load more, then the list's own Load more to #101, planned |
| Linear: issue lists (`loadList`, `loadMore`) | A newer read cleared `loadingMore` only when it succeeded; one that failed (a view gone) left it set. A workspace taken off during Load more got its page back into the list. The button said Load more, doing nothing, while the list was read again | A read clears it as it starts. A page of a workspace taken off is dropped, its cursor with it. "Loading…" while the list is read | `linearStore.test.ts` |
| Linear: saved views (`loadViews`, Load more views) | Read again during Load more views, the old page joined the views read since (a view deleted in Linear came back); an older read could replace a newer one | The newest read stands; Load more views adds only to the views it was asked for | `linearStore.test.ts` |
| Linear: projects | Right as is: one flag for both reads; Load more projects waits for a read; a newer read drops an older Load more and clears the flag itself | A workspace taken off: its page is dropped, as for issue lists | Reading |
| Linear: favorites; issue options and filter catalogs | Right as is: favorites come with the views' read (its guard now). Options and catalogs have no paging control and no loading flag: they are read whole and cached per team or workspace, and two reads at once read the same | — | — |
| Gmail: a search and Load more messages (`searchMail`) | A search left behind that failed showed its error over the newer one, and cleared its loading. Refresh during Load more let the old page join the list read again. An account gone during a search left the list loading (the panel searches only when nothing is), with the old account's cursor | The newest search's answer stands. Another account clears loading and the cursor, so the panel searches it | `superseded.test.ts` |
| Gmail: an email task's thread (`loadThread`) | Two reads at once (after an action): the older answer, or its error, could show last | The newest read of each thread stands | `superseded.test.ts` |
| Google Tasks: the Tasks panel's list (`refreshTasks`) | The older of two reads could show over the newer; a failed read left behind showed its error | The newest read stands | `superseded.test.ts` |
| Google Tasks: the Tasks view's lists (`loadBoard`) | Two reads at once (after changes made there): the older answer replaced the newer, and was followed up (series, moves) | The newest read of each list shows, and only it is followed up | `superseded.test.ts` |
| Google Drive: More files in the attachment picker | A search typed while More files was on its way: the page joined the new search's files and set its cursor. Clicked again while loading, it asked again | Dropped once the search changed; "Loading…", disabled, while on its way | Reading only: the picker's state is a component's, and the unit tests have no DOM. `tasks-calendar.mjs`'s `advanced` part runs the picker |
| Google Calendar: event search; an event's declined meetings | Right as is: one request a query, dropped by its effect's cleanup when another query comes; no paging (Google's "more" says to narrow the search) | — | — |
| Daily highlights: GitHub activity (`readAndKeep`) | A day's read is kept a few minutes for going back to it: one asked before a Refresh, answering last, replaced the newer one in what was kept | What is kept is the read asked for last | `superseded.test.ts` |
| The agents and models to assign to (`loadCatalog`) | Look again during a read: the older answer could show last. Another folder before the models came: the first folder's follow-up read it again, over the second | The newest read stands; only it reads the models again | `superseded.test.ts` |
| Other effects with a `live` flag (the calendar's feed, oc-forge's state) | Right as is: an effect's cleanup drops what it asked for | — | — |

## The journeys across midnight

`sunsama.mjs` read its dates once, at the start. A run that crossed midnight in Los Angeles compared the plan with
yesterday's dates, then waited for a menu item, "Plan HAR-3 on Saturday, October 31", that had become "Tomorrow".
Each phase now reads its dates as it begins: a part at a size, or the main flow. Before that it waits out any
midnight less than `SUNSAMA_MIDNIGHT_MARGIN_MIN` minutes away (default 20; a phase takes a few minutes), so no phase
crosses one (`tests/e2e/days.mjs`). The browser's zone stays Los Angeles, with its daylight saving and its midnights;
`SUNSAMA_ZONE` picks another one for every part and the main flow. The product's own day logic is tested as before:
each phase compares the day the Planner shows with the one the journey computes for that zone.

| Journey | Its dates | Now |
|---|---|---|
| `sunsama.mjs` | Read once at the start; Los Angeles hard-coded in two places. Its GitHub part dates the day's work at today's hours, and the Repository choice's order then held only after 4 PM (before, that work was still to come and outranked the repository meant to be the latest) | Read per phase, after `waitOutMidnight`; one zone, `SUNSAMA_ZONE`. The latest repository is updated after the end of today |
| `calendar.mjs` | Today read once, for a run of about 20 minutes | Waits out a midnight less than 30 minutes away, then reads today |
| `linear.mjs` | `dayKey` read the clock at each use, in steps of 24 hours (on a 25-hour day such as November 1, "tomorrow" in its first hour was today) | Today read once at the start, after waiting out a midnight less than 10 minutes away; calendar days from it |
| `run.mjs` | Today from the plan's first read, for the rest of the run | Waits out a midnight less than 30 minutes away in the plan's zone, then reads it again (not run here: it uses the installed Planner) |
| `forge.mjs` | Today from its plan, for a run of a minute | Waits out a midnight less than 10 minutes away in the plan's zone |
| `undo.mjs` | Today read once; its tasks are seeded there and looked for in the column marked today | The same assumption. The file belongs to the subtask work under way, so it is left to it: the same `waitOutMidnight` before reading today |
| `smoke.mjs` | No dates | — |
| `agentpr.mjs` | Adds its task in the column marked today and finds it there seconds later; no stored date | — |
| `tasks-calendar.mjs` | Already runs in a zone where it is between 10 AM and 10 PM | — |

## A journey's clean shutdown

`harness.mjs`'s `close()` waits until the Planner's requests have been taken by its routes, plus a moment of quiet,
before closing (9ed53cf): a request still paused for a route when the page or the routes go reaches the real service.
`run.mjs`, `agentpr.mjs` and `forge.mjs` do not use the harness. They now close through `tests/e2e/drain.mjs`, attached
right after `newContext`: it waits until no Planner request is in flight (each answered, by its route or the service,
or failed) and none was sent for 1.5 s, at most 15 s; then it closes the pages while the routes still answer, removes
the routes, and closes the browser.

## Sunsama's integration pages, behaviour by behaviour

Round 12's inventory of help.sunsama.com's integration pages for the sources the Planner has
([Gmail](https://help.sunsama.com/docs/integrations/gmail), [Linear](https://help.sunsama.com/docs/integrations/linear),
[GitHub](https://help.sunsama.com/docs/integrations/github), [Calendar](https://help.sunsama.com/docs/integrations/calendar))
and the pages they link about importing, completing and syncing:
[Importing Meetings](https://help.sunsama.com/docs/usage-guides/importing-meetings),
[Choosing your calendar](https://help.sunsama.com/docs/usage-guides/timeboxing/timeboxing-choosing-calendar),
the basics of [importing tasks](https://help.sunsama.com/docs/getting-started/basics/importing-and-creating-tasks) and
[events](https://help.sunsama.com/docs/getting-started/basics/importing-events-the-basics),
[Merge Tasks](https://help.sunsama.com/docs/usage-guides/tasks/merge-tasks) (the Gmail page's tip), the integrations' keys in
[Keyboard Shortcuts](https://help.sunsama.com/docs/usage-guides/keyboard-driven-actions/keyboard-shortcuts), and
[Add via URL](https://help.sunsama.com/docs/usage-guides/tasks/add-via-url) (see [Pasted URLs](#pasted-urls-source-by-source)).
Outlook's page is left out: the Planner has no Outlook. **Before**: there before round 12's inventory; **Now**: built in
it, with Sunsama's words and defaults; **N/A**: with why. Checks: `sunsama.mjs` parts `gmail`, `meetings` and `github`,
and `linear.mjs`'s `sunsamaLinear`, each at 1440 and 1024; unit tests named as they are.

| Page | What Sunsama documents | Planner | Check |
|---|---|---|---|
| Gmail | "Add Gmail account" in Settings or from the panel | Before: Settings → Google signs an account in with Gmail ticked; the Gmail source says where | `taskAdvanced.test.ts` (a sign-in against the fake Google) |
| Gmail | "Only … one Gmail account at a time" | N/A: Sunsama's limit; the Planner connects several, one picked in the panel | `sunsama.mjs` gmail (two accounts) |
| Gmail | Connecting Gmail does not connect that account's calendar | Before: each account's features are picked at sign-in (Calendar, Tasks, Gmail, Drive, Gmail actions, Contacts) | `taskAdvanced.test.ts` (a feature added by a sign-in) |
| Gmail | Custom email client: Superhuman; emails in the task list and the panel open there | Now: Settings → Gmail → Custom email client (Gmail, Superhuman); the task's Open, the card's icon, S and G open there. Superhuman documents no link format: `mail.superhuman.com/<account>/thread/<Gmail thread id>` is a best guess, unconfirmed | `sunsama.mjs` gmail; `gmail.test.ts` |
| Gmail | Open Gmail in the right-hand panel, Shift G | Now (the panel was there): Shift G | `sunsama.mjs` gmail |
| Gmail | Labels: "not additive by default"; Cmd or Ctrl adds; "only … emails that match all selected labels" | Now: one label a click, Cmd/Ctrl+click adds or removes; the labels shown make one Gmail search | `sunsama.mjs` gmail; `gmail.test.ts` |
| Gmail | Filters: Archived, Spam and Trash, Already imported into Sunsama; none of the first two while only the Inbox shows | Now: the three filters, off at first (the FAQ: "make sure to show archived and imported emails"); the Inbox keeps archived ones out | `sunsama.mjs` gmail |
| Gmail | Import: the subject is the title; drag into the list, or "Add to today" or a date | Before | `sunsama.mjs` main flow (drags), gmail (Plan … today) |
| Gmail | Drop an email on the calendar at a time: the task, and a working session | Before: the panel's calendar (and "Calendar below") takes panel items at a time | `sunsama.mjs` main flow (the same drop, checked with a Linear issue on "Calendar below") |
| Gmail | Tab switches to calendar view | N/A: Tab moves the keyboard focus in OpenChamber (needed to reach every control); the calendar is a nav item, and the panel's | — |
| Gmail | "merge an email directly into your daily recurring task" | Now: Alt/Option + drop from the panel, or `>` (see Merge Tasks) | `sunsama.mjs` gmail |
| Gmail | The task embeds the thread and its conversation, to browse and collapse | Now: the latest message open, the others a click away; where Gmail has it (Inbox, Archived, trash; unread, starred) | `sunsama.mjs` gmail |
| Gmail | Actions in Gmail: Open in Gmail (S), Archive, Move to trash, Mark as unread | Now: done in Gmail (a thread-level change), with the account's "Gmail actions" (gmail.modify: never a delete), asked for on first use; without it the task says how | `sunsama.mjs` gmail; `gmail.test.ts` (routes against the fake Google, 403 without it) |
| Gmail | The task as a worksheet: notes, time tracking, subtasks, comments, none synced back | Before: notes, time and subtasks stay in the Planner. Comments N/A: Sunsama's task comments are for teammates, and a plan here is one person's | — |
| Gmail | Import and completion automations, several actions at once | Now: Settings → Gmail: Mark as read, Mark as unread, Archive, Move to trash, Star, Unstar, Apply a label, Remove a label (by name; the label must exist in Gmail); none at first | `sunsama.mjs` gmail (Gmail's labels after an import); `gmail.test.ts` |
| Gmail | "Show Prompt": choose the actions email by email, on import and on completion | Now: the configured ones ticked, any other picked | `sunsama.mjs` gmail; `gmail.test.ts` |
| Gmail | Best practices: "Inbox Zero" (Mark as read and Remove a label: Inbox on import, Archive on completion; Apply and Remove a label "In progress") | Now: every action named; the settings say this set-up | `sunsama.mjs` gmail |
| Gmail | FAQ: "Re-add Gmail Account" in the panel when the access was revoked | Now: Re-add Gmail account under the error (a sign-in for the account's features) | `sunsama.mjs` gmail (the fake takes its access back); `gmail.test.ts` |
| Gmail | FAQ: "Speak with your GSuite administrator"; revoking in Google's permissions | N/A: Google's account settings | — |
| Linear | Add Linear in Settings or from the panel | Before: OpenChamber's Linear connection, or a workspace by API key in Settings | `linear.mjs` (step 11) |
| Linear | Several accounts and workspaces; remove or reconnect them | Before | `linear.mjs` (11); `linearWorkspaces.test.ts` |
| Linear | The panel by its icon; Command Palette "Linear" | Before: the source rail; Cmd/Ctrl+K → Linear | `linear.mjs` (9) for the rail; none of its own for Cmd/Ctrl+K |
| Linear | The account or workspace, picked at the top of the panel | Before | `linear.mjs` (11) |
| Linear | My issues: assigned, created, subscribed | Before | `linear.mjs` (9) |
| Linear | My issues: completed issues show five days | Now: the panel's My issues keep issues completed or canceled in the past five days ("Past 5 days" in Display too) | `linear.mjs` (`sunsamaLinear`); `linearStore.test.ts` |
| Linear | Issues sorted by creation date, no other ordering | N/A as a limit: the Planner orders, filters and groups as Linear does (AGENTS.md 2.i.c asks for Linear's own) | `linear.mjs` |
| Linear | Custom views browsed and imported from | Before | `linear.mjs` (2–4) |
| Linear | "Create a View for Sunsama" in the views menu; "Edit View in Linear" | Now: "Create a view in Linear ↗" (My issues), "Edit view in Linear ↗" (a view) | `linear.mjs` (`sunsamaLinear`) |
| Linear | Filter by already imported | Now: "Show already imported" (on: Sunsama names no default; off says how many are left out) | `linear.mjs` (`sunsamaLinear`) |
| Linear | Import: drag into the list, onto the calendar, or "Add to today" or a date | Before | `linear.mjs` (5), `sunsama.mjs` main flow |
| Linear | Add via URL | Before (round 11) | `pastedUrl.test.ts` |
| Linear | "the Linear icon on the card. Clicking on this icon will bring you to the issue in Linear" | Now: every linked card shows its tool's icon (Linear, GitHub, Gmail, Google Tasks, Google Calendar, a link), a click opening the item; G too, and the right-click menu's "Open in …" | `linear.mjs`, `sunsama.mjs` github and gmail |
| Linear | A preview of the issue inside the task | Before: the task's Linear section (status, description, comments; edits) | none of its own |
| Linear | Completion automations: "Show prompt to update status in Linear" | Now: the prompt offers the team's states, Done picked first ("Move to Done"); Always moves it by itself | `linear.mjs` (`sunsamaLinear`); `linearStore.test.ts` |
| Linear | Import automations: "Show prompt to update status in Linear" right after importing | Now: Settings → Linear (off at first): after an issue is imported, or merged straight in | `linear.mjs` (`sunsamaLinear`); `linearStore.test.ts` |
| Linear | "Updating Linear issue status when adding via URL" | Now: a pasted issue's status shows in the add field (Add task and the A window), to change before Enter | `linear.mjs` (`sunsamaLinear`); `linearStore.test.ts` |
| GitHub | The GitHub App: Add Account, installing it for private repositories and organizations, managing installations | N/A: the Planner reads GitHub through the GitHub CLI signed in where OpenChamber runs (its account, its scopes); there is no app to install. Not signed in, the source says where to run `gh auth login` | `sunsama.mjs` github (signed out) |
| GitHub | "surface the most relevant repositories" (the ones recently contributed to) | Now: a Repository choice of the repositories you work in, the latest pushed first; it narrows the search (`repo:`) | `sunsama.mjs` github; `fakeGithub.test.ts`, `github.test.ts` |
| GitHub | Read-only: issues, pull requests, discussions; never code | Before: the source reads issues, pull requests and the day's activity, and writes nothing to GitHub | — |
| GitHub | Pull in issues and pull requests | Before | `sunsama.mjs` github |
| GitHub | The work done on GitHub in the end-of-day review | Before (round 12) | `sunsama.mjs` github (Daily highlights) |
| GitHub | Add an issue by its URL | Before (round 12) | `sunsama.mjs` github; `pastedUrl.test.ts` |
| Calendar | A built-in private calendar for sessions, off the shared calendars | Before: sessions stay in the Planner unless "Write working sessions to" names a Google calendar | `run.mjs` |
| Calendar | Google, Outlook, Apple (iCloud) and CalDAV accounts, several; remove one | Before for Google (several accounts). Outlook, iCloud and CalDAV N/A: AGENTS.md 2.i.a scopes the calendar to Google Calendar; any calendar's ICS address can be subscribed, read-only | `calendar.mjs` |
| Calendar | "Enable" each calendar, to show or timebox | Before: Settings → Google calendars to show; the calendar's rail | `calendar.mjs` |
| Calendar | The calendar in the right-hand panel, by its icon or Shift C; the left-most day of the board shows there | Now: Shift C. Before: the left-most day | `sunsama.mjs` meetings |
| Calendar | "click on the name of that date at the top of its task list" to show its calendar | Now | `sunsama.mjs` meetings |
| Calendar | Calendar view: "Board" or Tab | Before: the Calendar page. Tab N/A (above) | `calendar.mjs` |
| Calendar | "Calendars" at the top of the calendar toggles each one's visibility | Now in the panel's calendar (the Calendar page's rail had it) | `sunsama.mjs` meetings |
| Calendar | Show declined events | Before: the calendar's Settings menu | none of its own |
| Calendar | Create events by click or drag, on a writable calendar, with description, privacy, availability and invitees; edit and delete them in their calendar | Before | `calendar.mjs` |
| Calendar | Meeting import's four settings | Now (see Importing Meetings) | `sunsama.mjs` meetings |
| Calendar | Timebox by dragging, or X | Before | `run.mjs`, `calendar.mjs` |
| Calendar | A default calendar for timeboxing; a channel linked to a calendar | Before: "Write working sessions to (default for tasks)". Now: Timeboxing channels (below) | `sunsama.mjs` meetings; `googleTimeboxes.test.ts` |
| Calendar | Zoom | N/A: a separate product account; Google Meet is added in the event editor | `calendar.mjs` (Meet) |
| Calendar | Google Contacts, to find invitees | Now: guests suggested from the account's contacts and the people it emailed, once it allows "Contacts" (read only; asked for from the event editor) | `sunsama.mjs` meetings; `gmail.test.ts` (route, 403 without it) |
| Calendar | Apple Calendar FAQ | N/A | — |
| Importing Meetings | Meetings in the task list: the day's workload, "time spent in meetings added to your daily stats", checking them off | Now: an event's task has its length as planned time; completed, it counts as time spent ("planned as actual", on at first) | `meetings.test.ts` |
| Importing Meetings | "Add to tasks" on hover, or from the event's page | Now: the event's details and the grid's hover + | `sunsama.mjs` meetings |
| Importing Meetings | Daily planning's first step: "fill in calendar events", the green button imports the suggested ones and "auto-sorts based on start times"; "pick events" | Now: "Fill in calendar events" (Import N events, Pick events), each placed by its start time | `sunsama.mjs` meetings |
| Importing Meetings | Auto-sync; "You must select Calendars to import from" | Now: Settings → Meeting import (Show prompt at first), every 5 minutes in the service and at once on a change | `sunsama.mjs` meetings; `meetings.test.ts` |
| Importing Meetings | Calendars to import from; none chosen: suggestions from the visible calendars | Now | `meetings.test.ts` |
| Importing Meetings | The five exclusions, on by default: no other attendees, non-blocking, "OOO" or "HOLD", attendance not confirmed, multi-day all-day; Auto-sync skips them, Show prompt leaves them unticked | Now, with the same names and defaults; declined meetings never | `sunsama.mjs` meetings; `meetings.test.ts` |
| Importing Meetings | A settings change adds or removes those meetings at once; one removed by hand is never added again; one whose actual time was edited stays | Now (a removed one comes back by hand, as the user's own) | `sunsama.mjs` meetings; `meetings.test.ts` |
| Importing Meetings | Auto-complete: Always (default), Never, Only if the event has invitees; never while its timer runs | Now | `sunsama.mjs` meetings (Always, the setting); `meetings.test.ts` |
| Importing Meetings | "Remove from tasks" on right-click, the event left in the calendar | Now: the task's menu opens on right-click | `sunsama.mjs` meetings |
| Choosing your calendar | "Default for tasks", a fallback that never overrides a channel's | Before; now it is the fallback | `googleTimeboxes.test.ts` |
| Choosing your calendar | "Timeboxing Channel": a channel's tasks timeboxed to its calendar | Now: Settings → Google → Timeboxing channels | `sunsama.mjs` meetings; `googleTimeboxes.test.ts` |
| Choosing your calendar | "Import channel": the channel imported events of a calendar get | Now: Settings → Meeting import, per calendar to import from | `sunsama.mjs` meetings; `meetings.test.ts` |
| Choosing your calendar | The Sunsama calendar as "Default for tasks" keeps sessions off Google | Before: "Don't write them" (at first) | `run.mjs` |
| Importing tasks: the basics | Calendar icons on event tasks; integrated cards show the tool's icon; URL tasks a link icon | Now | `sunsama.mjs` github, gmail |
| Importing tasks: the basics | Global add task, outside the app | N/A: OpenChamber is a web page with no system-wide shortcut; the A window is in the Planner | — |
| Merge Tasks | Alt/Option + drop a task onto another: a subtask keeping its notes, planned time and integrated information | Now; "Merged in" in the task lists them | `sunsama.mjs` meetings; `merge.test.ts` |
| Merge Tasks | Integration tasks merged "will still be fully integrated, synced tasks"; merged straight from the panel | Now for Linear and GitHub (state and title follow, closed ones checked off) and for each integration's own automations, as on the task's own item: an item merged straight in is imported (Linear's and Gmail's import automations); one checked off runs its completion automation; and completing the task it is merged into runs it for the merged items still open (not checked off on their own, which ran theirs, or asked, then; nor closed in Linear or completed in Google Tasks), as checking each off would. Each integration asks with its own setting and prompt (Linear's "Show prompt to update status in Linear", Gmail's "Show prompt", Google's "When I complete a Google task": Ask me), once for the task and all its merged items: one Linear issue keeps the status picker, several each go to their team's first completed state; Gmail does the actions picked to each email. Reopening the task does what unchecking does: a merged Google task is reopened in Google Tasks unless it was checked off on its own; Linear and Gmail have no reopen automation (Sunsama's are for importing and completing), so nothing changes there, and an item checked off on its own keeps that state. GitHub stays read-only, as in Sunsama. A merged Google task, as a linked one is (Settings → Google → "When I complete a Google task": Complete it in Google Tasks, at first; Ask me; Leave Google Tasks alone): checked off, or its task completed, it is completed in Google Tasks (its own subtasks there first); opened again, or its task reopened, reopened there. Its link follows Google (state, title, list; one Google moved under a new id is followed, one deleted there says so and is read no more), and a completion new in Google checks it off with "Complete a task when it is completed in Google Tasks". A write Google refuses is said; a tick it refused goes back | `sunsama.mjs` gmail, meetings, `linear.mjs` (`sunsamaLinear`), each at 1440 and 1024; `merge.test.ts`, `mergeGoogle.test.ts`, `gmail.test.ts`, `linearStore.test.ts` |
| Merge Tasks | Subtask keys: G opens it, Space starts its timer, I its preview | Now: G over a merged item. Space and I N/A: the Planner's subtasks have no time of their own (time is the task's) and no preview; Open is on the row | `sunsama.mjs` gmail |
| Merge Tasks | "convert to task" | Now (its notes, planned time and link back; not an import again) | `sunsama.mjs` gmail; `merge.test.ts` |
| Merge Tasks | `>` in the add task modal | Now: `>` and the start of a task's title; the field names the task | `sunsama.mjs` github; `merge.test.ts` |
| Merge Tasks | "Cannot merge events", either way | Now | `sunsama.mjs` meetings; `merge.test.ts` |
| Merge Tasks | So event tasks have no subtasks at all ("use a checklist or plain-text breakdown in its Notes field … or create a separate, non-event task") | Now: merges into them are refused as Sunsama refuses them; an event task's details (and Focus) have no Add subtask, but Sunsama's advice: "Calendar event tasks can't have subtasks: break this one down in its notes, or make a separate task for what needs real subtasks." The service refuses a subtask added to one ("Calendar event tasks can't have subtasks"); subtasks one had before stay, to tick, rename, convert or delete | `sunsama.mjs` meetings; `mergeGoogle.test.ts`, `merge.test.ts` |
| Keyboard Shortcuts | G opens a linked task in its tool; Shift G (Gmail), S (Gmail), Shift C (calendar) | Now | `sunsama.mjs` github, gmail, meetings |

## Pasted URLs, source by source

A URL pasted alone as a new task's title (in a day's Add task and the `A` window),
compared with what Sunsama documents (its [Add via URL](https://help.sunsama.com/docs/usage-guides/tasks/add-via-url),
[GitHub](https://help.sunsama.com/docs/integrations/github), [Linear](https://help.sunsama.com/docs/integrations/linear)
and [Gmail](https://help.sunsama.com/docs/integrations/gmail) pages, read 2026-10-29). As in Sunsama, the field
says what Enter does before it is pressed; `~30m` and `@friday` after the URL still plan its time and day.
Code: `src/domain/pastedUrl.ts`, `panel/lib/addTask.ts`.

| Pasted | Sunsama | The Planner |
|---|---|---|
| A Linear issue (`linear.app/<workspace>/issue/KEY-1/…`) | Imports the issue as a linked task | The same, looked up in the workspace the URL names (as before round 12); Linear not connected: a task linked to the page, and how to connect |
| A GitHub issue (`github.com/<owner>/<repo>/issues/<n>`, a comment's address too) | "Sunsama will automatically create a full task containing the GitHub issue's details" | A task linked to the issue (its id, title, state, URL), found by its URL through `gh` (`resource(url:)`), one in no list too (not assigned to me); not found, or `gh` signed out: a task linked to the page, saying why |
| A GitHub pull request (`…/pull/<n>`, its files tab too) | Its GitHub integration imports issues and pull requests; its URL tip speaks of issues | The same as an issue |
| A Gmail message | Add via URL imports it from a connected Gmail | Gmail's legacy addresses (`#inbox/<16 hex>`, `?th=`) and a printed message's (`thread-f:`, `msg-f:`) name the message: the email, as Google → Gmail plans it, looked up in the account the address names (`authuser`) and then in each with Gmail (`POST /google/mail/resolve`). Gmail's own addresses today (`#inbox/FMfcgz…`) carry a token encrypted for the account that no other app can read ([googleworkspace/cli#790](https://github.com/googleworkspace/cli/issues/790)): a task linked to the page, and the Planner says to plan the email from Google → Gmail |
| A Google Calendar event (`calendar.google.com/calendar/event?eid=…`, `…/r/eventedit/<eid>`) | Not documented: events come in from the calendar ("Add to tasks"), so a pasted event address is any other page | Its `eid` names the event and its calendar: the event, looked up in the connected accounts, is added as "Add to tasks" adds it (a task linked to the event, on its day by its start time, its length as planned time); one in the tasks already says so; not found: a task linked to the page |
| Any other page | "Tasks from URL": a task with a backlink to the page | A task titled from the address (`host › path`; no page is fetched), the page as its link (Open link, Unlink in its details); `http` pages too |
| A tool that is not connected | Sunsama offers to connect it | Linear and GitHub say how to connect; the task is linked to the page meanwhile |

## The end of the day, integration by integration

What Sunsama's integration pages ([GitHub](https://help.sunsama.com/docs/integrations/github),
[Linear](https://help.sunsama.com/docs/integrations/linear), [Gmail](https://help.sunsama.com/docs/integrations/gmail),
[Calendar](https://help.sunsama.com/docs/integrations/calendar)) and its
[Daily Highlights](https://help.sunsama.com/docs/usage-guides/daily-highlights) page (read 2026-10-29) put in the
end-of-day review, and where the Planner has it. As in Sunsama, the daily shutdown's Done for the day goes on to the
highlights. Checked by `sunsama.mjs` (its GitHub part, at 1440 and 1024, through the real `gh` against the fake
GitHub), `githubActivity.test.ts` and `fakeGithub.test.ts`.

| Sunsama | In the end-of-day review | The Planner |
|---|---|---|
| GitHub integration | "Automatically surface the work you did in GitHub (comments, PRs, discussions) in your end of day review (see Daily Highlights)" | Daily highlights → Other activities → GitHub, for the day shown (its date picker), as the user `gh` is signed in as: **Pull requests** opened, reviewed (one row a pull request, its last review's state, "×2" for two) and merged (yours, by whoever merged them, and others' you merged); **Comments** on issues and pull requests (one row a thread, opening the latest); **Discussions** started and commented on. Each row opens on GitHub in a new tab (a click, Cmd/Ctrl+click or a middle click). Include adds it to the highlights as "Merged pull request owner/repo#7: title", with its link (↗, and in Copy as text), to star, edit, reorder or remove as any highlight; the row then says Included. Not signed in: how to sign in, as the GitHub source says it |
| Daily Highlights: Other activities | "An exhaustive list of tasks, to-dos, items, and emails tracked via Sunsama"; "Include", "visible only to you" | Other activities → Tasks: the day's tasks not among the highlights (completed ones removed from them, and open ones), wherever they came from: Linear issues, GitHub items, Gmail messages, Google tasks and meetings are tasks once planned. Include adds one. Other activities stay out of Copy as text and of what Publish keeps, which are the highlights alone |
| Daily Highlights: retroactive data | "If your integrations are not set up or it is your first day, Sunsama may not have retroactive activity data from other tools" | GitHub is read when the day is shown, so any earlier day has its work |
| Linear integration | Nothing: its page covers connecting, browsing and importing issues, Add via URL and status automations on import and completion | Linear issues planned as tasks are tasks: done ones are highlights, open ones in Other activities |
| Gmail integration | Nothing: its page covers labels and filters, importing, the thread in the task, actions on the email and import and completion automations | Emails planned as tasks are tasks, as above |
| Calendar integration | Nothing: its page covers calendars, events, meeting import and timeboxing | Meetings planned as tasks are tasks, as above |

How the Planner reads GitHub's day (`service/githubActivity.ts`), each source a page of 50 at a time with its cursor,
the first page of all of them in one `gh api graphql` call:

| What | Read from | Why |
|---|---|---|
| Pull requests opened | GitHub's search, `is:pr author:@me created:<the day>` | The day as a range of instants in the Planner's time zone (`2026-10-29T07:00:00+00:00..2026-10-30T06:59:59+00:00`) |
| Pull requests merged | `is:pr is:merged author:@me merged:<the day>`; and `-author:@me` with `reviewed-by:@me` or `involves:@me`, kept when `mergedBy` is the user | GitHub's search has no merged-by: a pull request someone else wrote is found through the user's review of it or part in it (author, assignee, commenter, mention), which merging one nearly always comes with |
| Reviews | `viewer.contributionsCollection(from:, to:).pullRequestReviewContributions` | Each review at the time it was submitted; a search dates the pull request, not the review |
| Comments on issues and pull requests | `viewer.issueComments`, last updated first, until one was last updated before the day | The user's own comments, so a busy thread's other comments never hide one |
| Discussions started | `viewer.repositoryDiscussions`, newest first (GitHub's documented order), until one is older | |
| Discussion comments | `viewer.repositoryDiscussionComments`, read from the end | GitHub doesn't document this list's order: read as oldest first, and a page that comes newest first turns the reading to start from the beginning |

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
6. Google (optional): in a Google Cloud project, enable the Google Calendar, Google Tasks,
   Gmail and Google Drive APIs, set up the OAuth consent screen (yourself as a test user), and
   create an OAuth client ID of type Desktop app. Planner → Settings → Google: paste its ID and
   secret, then Connect a Google account with Calendar, Tasks, Gmail and Drive as wanted (Drive,
   `drive.metadata.readonly`, can also be allowed later, from a task's "Add a Google Drive
   attachment"). Tick the calendars to show, and choose the one working sessions are written to.
7. AI features need a Small Model (a provider key, or Settings → Sessions → Small Model);
   without one they say so and the rest works.

## Limits of an OpenChamber extension

No mobile or VS Code surface, no tray, menu bar or global shortcut, no notifications when
no Planner surface is open, one integration slot (Linear; further Linear workspaces use API
keys, Google signs in through the service), no Outlook, Slack or Teams, Gmail read-only, no
team sharing. An extension cannot choose a chat's agent or model, so the Planner does it
through OpenCode commands; OpenChamber (2.5.2, and 2.5.3, whose send code is the same here) sends a new chat's first message before
OpenCode has loaded the commands of a folder it has just started, so an assignment's new
worktree is made first, with an empty "Worktree for …" chat that the extension cannot
delete. OpenCode 2.2 loads a folder's commands only when they are first asked for, and
answers that first request with none, so on a stock OpenChamber the assignee's command can
still go out as a plain prompt (the chat then runs on the default agent); oc-forge's
adapted OpenChamber asks again until the folder's commands are there
(`adapters/openchamber/README.md`, "Fixes"). The service cannot reach OpenChamber's own OpenCode server (it has a password), so
it can only ask OpenCode's background server, when one runs, whether a new command is
listed; otherwise it waits a moment.
Printing needs oc-forge's host: OpenChamber sandboxes an extension's frames with
`allow-scripts` alone, where Chrome ignores `print()`; oc-forge's adapted OpenChamber adds
`allow-modals` (and its CSP sandbox) for an extension that asks (`"ocForge": { "modals": true }`
in `package.json`), and says so in its hello (`modals`). The frame prints its own document, so
nothing of OpenChamber's UI prints.
Google's own APIs set further limits: Google Tasks' API keeps a task's date without a time
and has no deadline, repeat, star, availability, visibility or notification for other apps
(https://developers.google.com/workspace/tasks/reference/rest/v1/tasks), so the Planner keeps
those itself, in its event log by account and task id (following moves), shown on every
Planner surface but not in Google's own apps; nothing is written into a task's title or
details. A repeating series made in Google Tasks cannot be read either: its occurrences show
as single tasks. So Google's own apps notify a task the Planner times only at 9 AM on its
date, and never for its deadline, while the Planner's task notifications come only in
OpenChamber, while one of its surfaces is open (an extension has no notification of its own
when none is, nor a desktop one: its frame has no origin to ask permission with); the
notifications it has given are kept on that machine in `task-notifications.json`, beside the
data repository and never synced, so a reload or a restart gives none twice (another machine
sharing the plan gives its own). Google Calendar shows others no task the Planner times (it
gets no time for it, and keeps a task without one private), so a task's visibility reaches
others only through its working sessions, and Busy changes what the Planner plans around and
which meetings it declines (Google's free/busy for others never sees it). A task's color,
attachments, Do not disturb and declining are the Planner's too: Google's own apps show none of
them. Do not disturb mutes only the Planner's own task notifications (an extension can't mute
Google Chat, other apps or OpenChamber's notifications); declining runs in the Planner's service,
so only while OpenChamber runs, on the account's primary calendar, two weeks ahead (Google's
own Focus time events, with their `autoDeclineMode`, would decline without the Planner but add
an event per task). Drive attachments are links to the files (the Planner sees their names,
never their contents, and shares nothing); a work or school account whose administrator turned
Drive off gets Google's refusal. What was declined is kept on that machine in
`declined-meetings.json`, beside the data and never synced. An event's
notifications are Google Calendar's own: set on the event, Google sends them (in its apps and
by email); the Planner draws none for events. Pending tasks read every list's open tasks dated
in the past 365 days, as Google Calendar gathers them. Google Calendar's appointment schedules and working location are not part
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
node ../../extensions/planner/tests/e2e/undo.mjs /tmp/opencode/planner-undo-journey  # the Planner's own Undo in two windows, at 1440 and 1024 (harness.mjs)
node ../../extensions/planner/tests/e2e/calendar.mjs /tmp/planner-calendar   # this build, a fake Google
node ../../extensions/planner/tests/e2e/tasks-calendar.mjs /tmp/planner-tasks-calendar   # Pending tasks, notifications, advanced settings, Drive, colors, Do not disturb, declining, the inventory, printing (a fake Google; TC_PARTS=tasks|advanced|inventory|print|decline runs one part)
node ../../extensions/planner/tests/e2e/agentpr.mjs http://<bind>:35310   # the installed extension, a real agent, a fake GitHub
node ../../extensions/planner/tests/e2e/forge.mjs                          # Cmd+click, deep links and keys on the adapters' scratch stack (its header says how)
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
container's OpenChamber (`tests/e2e/harness.mjs`; on oc-forge's adapted OpenChamber it keeps
the page's service requests on HTTP, where its routes answer them, with the host's
`oc-forge:service-socket` switch): the sources panel, drags onto days and the
calendar, daily planning, the assignee picker, and two real chats in `planner-demo-a` as
OpenCode's read-only plan agent, through a command file it writes to the container
(`oc-planner-harness-plan.md`) and removes, with the chats and worktrees, at the end.

The built `panel/main.js` and `service/main.js` are committed so the folder installs
without a build. The repository's root `.gitignore` ignores `lib/`; this package's own
`.gitignore` re-includes `panel/lib/`. A manifest that changes capabilities or service
permissions needs approval again. The e2e journey (`run.mjs`) works in the installed
Planner's real plan and leaves it as it found it. First it removes what a crashed run left
(tasks, chats, worktrees, time entries, calendar blocks, series, folders, calendars,
objectives, ritual text carrying a run's tag). At the end it removes what it made and puts
the rituals and settings it changed back as they were: the day's planning, shutdown and
highlights, the week's planning and review, the Linear page's display, the Pomodoro
lengths, the Google session calendar. Its last check compares the plan with the one it
found (tasks, time, calendar, rituals, settings). It mocks Linear and the Small Model at the host's routes, and a second Linear
workspace, Google and pull request lookups at the service's routes, so it never touches a
real Linear workspace or Google account. Its one real Linear call
sends a made-up key, to check that the service refuses a key Linear rejects.
