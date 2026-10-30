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
| Tests | `tests/*.test.ts`, `tests/e2e/` | `bun test` for domain, service and panel helpers (Google writes through a mocked `fetch`, and the service run against `tests/e2e/fakeGoogle.mjs`); `fakeGithub.test.ts` runs the real `gh` against `tests/e2e/fakeGithub.mjs`. Playwright journeys against the dev container (`containers/openchamber-dev`): `run.mjs` and `agentpr.mjs` on the installed extension (`agentpr.mjs`: a real agent opens a pull request against the fake GitHub), and `harness.mjs` journeys on this checkout's build: `smoke.mjs`, `sunsama.mjs`, `linear.mjs`, `calendar.mjs` and `tasks-calendar.mjs` (their service signed in to the fake Google; task notifications are off in a harness's plan unless a journey turns them on, as `tasks-calendar.mjs` does). |

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
| Tasks | Title, notes, subtasks (a subtask can become a task), planned and actual time, channel, priority, start (day or backlog bucket), due date, objective, folder, repeat, activity log, duplicate, archive, trash, undo. A title, notes, planned time or subtask's title edited in place saves what changed from what it showed when editing began, over the task as it is then: one left as it was writes nothing (a change made in another window meanwhile shows), one changed in another window meanwhile too is asked about (Keep theirs, Save mine). Subtasks are ticked, added, renamed and deleted on the list as the plan has it then. |
| Add Task syntax | `~30m`, `@tomorrow` / `@fri` / `@oct 30` / `@backlog` / `@someday`, `#channel`, `!high`, `$objective`; `A` opens the Add task window. A URL pasted alone is taken as Sunsama's [Add via URL](https://help.sunsama.com/docs/usage-guides/tasks/add-via-url) takes it, and the field says what Enter will do: a Linear issue, a GitHub issue or pull request and a Gmail message become a task linked to them, a Google Calendar event is planned as "Plan as task" plans it, any other page is a task with that page as its link (see [Pasted URLs, source by source](#pasted-urls-source-by-source)). |
| Backlog | Six time buckets, folders, search, channel and context filters, Braindump (line by line, or organized by the Small Model and reviewed before adding). |
| Channels | Work and personal contexts; personal time stays out of the workload; filters; delete keeps tasks. |
| Workload | Planned time per day against a threshold; history-based estimate and channel suggestions; auto-sort; playlist times (when each open task would run in order). |
| Calendar | Laid out as Google Calendar: a rail with Create (an event or a task), the mini month and "My calendars" / "Other calendars" with colored checkboxes ("Display this only", a color); Today, the arrows, the range title and the view (Day, Week, Month, Year, Schedule; keys D, W, M, Y, 5, J, K; show weekends, declined events, completed tasks); search (`/`, the matching events of the calendars shown, a year back and two ahead, day by day as in Schedule); Settings (⚙) → Print, or Ctrl/⌘+P, Google Calendar's print preview of the range shown (see the inventory below); Calendar or Tasks. A newly connected account's own calendar shows at once, as in Google; shared ones wait to be ticked. Day and week grids with an all-day row of bars, each block's title wrapping over the lines its height allows with the time on its own line when there is room ("Title, 10am" on one line for short blocks; the full text in its label and tooltip); Month with bars, dotted timed events and "N more"; Schedule as Google's agenda. Click or drag on the grid (or click a month day) for quick create: an Event in a chosen Google calendar, or a Task, as in Google Calendar: one Google task on that day in a chosen list, at that time (kept in the Planner; with "The Planner only" a Planner task with a working session instead); "More options" opens the editor (times, all day, repeat presets and a custom rule, calendar, Google Meet, place, notifications, color, busy/free, visibility, description, guests). Click an event for its details (time, how it repeats, Meet, place, guests and their answers, description, notifications, calendar) with Edit, Delete, RSVP (Yes, No, Maybe), "Plan as task" and Options → Duplicate (the editor opens with a copy). Drag Google events to move them and their bottom edge to resize them; a recurring event asks This event, This and following events or All events, an event with guests whether to email them; everything is written to Google Calendar, and a snackbar says so, with Undo after moving or resizing one event. Unanswered, maybe and declined invitations show as Google draws them. Working sessions as before: drop tasks to timebox, drag, resize, remove; moving a session moves its task; auto-schedule into free time; sessions written to a chosen Google calendar follow it both ways. Google tasks with a date show on that day in the all-day row, or at their time in the grid with their check circle when they have one, completed ones struck through, planned ones marked and linked to their Planner task, a deadline flagged (red once passed) and shown on its own day in the all-day section as Google's flag (a task with only a deadline shows there alone; a timed task keeps its block and has its deadline there too, its own day included; an all-day task due on its deadline's day is one item, with its flag), and a repeating task's upcoming occurrences at their dates and times (lighter, with its repeat mark; the real one replaces each once Google has it, never two for one date; another task with the series' title on that date is a task of its own and shows beside it; their details show that task and how its series repeats, with Edit, asking This task or All tasks, and Delete, asking This task, This and following tasks or All tasks, as Google Calendar asks: This task edits that one alone in the calendar's task editor (its title, details, date, time and deadline; the series' repeat shown, locked) or deletes it, so its date shows nothing and the series goes on past it; an edited one shows its own values, a moved one on its new date, after a reload too; This and following tasks ends the series the day before it ("Daily, until …"), the open task and the upcoming ones before it staying as they were, also once those are done; All tasks edits the series, or deletes it with its completed tasks), in Day, Week, Month and Schedule, whenever an account with Tasks is connected; their details edit them (Edit opens the Tasks view's form over the calendar, which stays where it was: title, details, date and time, deadline, repeat, star and list; a repeating one asks This task or All tasks), complete, star, delete or plan them; dragging one to another day changes its date in Google (it keeps its time), dragging a timed one in the grid changes its time, and an all-day one dropped on the hours gets that time. Any event becomes a task on its day with its length as planned time; read-only ICS subscriptions (RRULE, EXDATE, overrides, time zones). Pending tasks, as in Google Calendar: today's all-day section (Day, Week, Month, Schedule) has "N pending tasks" for the open Google tasks dated in the past 365 days, which opens their list, latest first, each with its date, its time or All day, its repeat and its list; a row's circle completes it, Reschedule this task moves it to Today, Tomorrow or a date picked (Google's date; a time kept in the Planner stays) and Edit opens its editor; a task done or moved past yesterday leaves the list (read from every list with Tasks, without the completed ones; hidden with the Google tasks on the calendar). Task notifications, as Google Calendar gives them: at a task's time, at 9 AM for one with a date alone, and at 9 AM on its deadline's day to complete it (one due all day on its deadline's day gets that one alone), for the upcoming occurrences of a repeating task too, none for a time that had already passed when the task got it (Google sends none either). The Planner gives them itself, as OpenChamber notifications that stay until dismissed (OK), while one of its surfaces is open (the page, the rail panel or its Work Status section) in a window on screen: each once, to whichever surface or window asks first, and one missed while none was open comes when one opens, the same day; Settings → Google turns them off. Under "My calendars", Tasks has each task list as a row of its own, as Google Calendar lists them: a checkbox (its tasks on the calendar or not), "Display this only" and a color, which its tasks take on every view unless a task has its own (Advanced settings → its color: Google Calendar's eleven, or "List color"). A task's details show its color, its Drive attachments (each opens in Drive), "Do not disturb · Declines meetings" and the meetings declined for it. The rail and the unscheduled-tasks panel fold away when the week would get too narrow (the menu button and the panel button bring them back). |
| Time | One running timer, manual entries, actual vs planned, planned counts as actual (setting); a running-timer bar. |
| Rituals | Daily planning (5 steps, plans tomorrow after 3 PM; collects from the backlog, Linear, GitHub, Gmail, Google Tasks, meetings and objectives, and every add lands on the day being planned), daily shutdown, daily highlights (stars, custom items, AI summary, publish), weekly objectives, weekly planning (carry over), weekly review (progress, body of work, time by channel). |
| Rollover | At local midnight, with catch-up after downtime; rollover count; archive after N rollovers. |
| Recurrence | Daily, weekdays, every n weeks on chosen days, monthly (end-of-month aware), yearly; instances a week ahead; untouched instances give way to the next one; apply edits to upcoming; stop. |
| Stats | Completed tasks, actual time, actual vs planned, days planned, streak, work per day, time by channel. |
| Search & keys | Ctrl/Cmd+K palette (navigate, act, find any task, ask the assistant); `A`, `T`, `F`, `P`, `O`, and `C` / `Z` / `X` on the hovered card; on the Linear page, Linear's keys (`F` filters there, `[` folds its sidebar). |
| In OpenChamber | On oc-forge's adapted OpenChamber (`adapters/openchamber`; on a stock release these fall away): a Cmd/Ctrl+click or a middle click on a page, a task, a Linear issue or a task's chat opens it in a new browser tab, as on a link, while a plain click goes there in place; the page's address names where it is (`?extension=oc-forge-planner&route=/today?task=<id>`), so it can be reloaded, copied or opened from elsewhere; and OpenChamber's own keys (switching header tabs, chats and side panels, closing a tab, its sidebar and palette) work while the Planner has focus, except what the Planner uses itself: typing in a field, Cmd/Ctrl+K, and Cmd/Ctrl+B on the Linear page. |
| Linear | Several workspaces, shown merged or one at a time. A page laid out like Linear, with its own sidebar: My issues (Assigned, Created, Subscribed), Planned (the issues already in the plan), Favorites (views, projects and issues), every saved view by team and workspace (searchable; views of issues and of projects) and Projects; ↑/↓ and Enter, `/` to search (as one types), `G` then `I`, `V` or `P`, `[` to fold it away; it reopens where it was (kept on this device). Where the page is too narrow for it (1024 px with OpenChamber's sidebar open), the sidebar folds behind a toggle in the header and opens over the list, closing on Escape, a pick or a click outside; the header's search then takes `/`, and rows put properties that do not fit under the title. A saved view lists exactly the issues Linear lists for it: its own filter, what its display hides (completed issues by its window, sub-issues, triage) and every page (three at once, the rest on scroll or Load more, never a silent cap), opened with its layout, grouping, sub-grouping, ordering and properties (anything shown another way is named); a view of projects lists its projects. Filters as in Linear: Filter or `F` opens a searchable, keyboard-first menu (properties, then values with ticks; typing finds a value of any property; ↑/↓, Enter, Esc, Backspace back) of status, assignee, creator, priority, labels, content (the title or description contains, or does not contain, a text), project, milestone, team, cycle, estimate, subscribers, relations (blocked by, blocking, related, duplicate, a parent issue, sub-issues), the due, created, updated and completed dates, and the workspace ("Me" is whoever reads, in each workspace); chips such as "Status is either of Todo, In Progress" whose operator (is / is not; include any / all / none for labels, subscribers and relations; before / after a date, besides overdue, today, this week, next week, no due date, or a time ago; at least / at most for estimates) and values can be changed; "Match all / any" for the top-level filters; Advanced filter (in the menu) builds Linear's rows joined by and / or, and groups of them nested two deep, each switching between all and any; a group shows in the bar as "Any of 2 filters" and opens in the builder; Clear. A saved view opens with its own filter (its `filterData`) in the bar, an "or" as one group: while it holds as saved Linear applies it; changed here, the Planner asks for the view's team's issues with the filters as they are (Reset brings the view's back); parts the Planner cannot edit show in words and still apply. The choices come from the workspaces (every state, person, label, project, milestone, cycle and estimate scale; a team's view offers its team's), and the filters go to Linear as an `IssueFilter` with `and` and `or`, so the answer is complete. Display (`Shift V`): list or board (`Cmd/Ctrl B`), grouping and sub-grouping (status, assignee, project, priority, cycle, label, team, workspace), ordering (manual, status, priority, last updated, last created, due date, number) and its direction, completed issues (all, past day to past year, none), sub-issues, empty groups or columns, triage, and the properties rows show; a view's changes last while it is open, the Planner's own lists keep theirs. Status groups and board columns are the teams' exact workflow states in Linear's order (same-named states of several teams share one); dropping a card sets exactly that state, or the group's priority, assignee, project or cycle, in the card's own team, and a state its team lacks is refused. Projects: status, health, progress, lead, dates and teams; a project's issues as a full list (filters, display, board), its milestones, latest update and description. The issue view is laid out like Linear's: the title and Markdown description (Write / Preview, a formatting bar, Ctrl+B / Ctrl+I / Ctrl+Enter; checklist items ticked in place; a save that would overwrite a change made in Linear meanwhile asks first), sub-issues, the activity (history and Markdown comments), and a properties sidebar (status, priority, assignee, labels, project, cycle, estimate, due date; links) whose searchable menus open with `S`, `P`, `A`, `L` and `Shift D`; `J` / `K` move to the next or previous issue of the list, `Esc` closes the menu, then the issue; each change sends only that field. Plan by click or drag (also onto the calendar); completing asks (or always / never) to move the issue to Done; optional move to In Progress when planned; optional completion import; create an issue from a task in any workspace's team; an agent's new worktree defaults to Linear's branch name for the issue. The panels beside Today, the calendar and planning keep a list of their own (my issues, a view or a search, with the same filters). Nothing is left out unsaid (round 12): projects and saved views read 500 and 1,000 at once, the rest with Load more projects and Load more views; an issue's team options (people, labels, projects, states, cycles) are read page by page past 250; filter menus, the issue page (labels, sub-issues, links, comments, activity), a project's milestones, favorites and the team picker say when Linear has more than they read (see [Sources' limits](#sources-limits-one-by-one)). |
| GitHub | Assigned issues, review requests, my open PRs (read-only, like Sunsama, whose GitHub integration lets you "Pull in GitHub issues, PRs into your task list"), 50 at a time in GitHub's order (updated, newest first): "Showing 50 of 51" and Load more, to "All N shown"; a search field narrows the list in GitHub's own syntax (words, `repo:owner/name`, `label:bug`), and past GitHub's 1,000 results of a search the list says to narrow it; Refresh (↻) reads again as many as are shown, the rest still a Load more away. Plan and drag like Linear; linked items, every one of them (100 a call), keep their state and title. An issue's or a pull request's URL pasted into a new task imports it, as Sunsama does ("paste the URL of the issue into a new Sunsama task's title"), one in no list too. When `gh` is missing or not signed in, the source says so and where to run `gh auth login` (inside the container when OpenChamber runs in one). |
| Google Tasks | A Tasks view as the Google Tasks app (Calendar → Tasks, or Google → Google Tasks): lists in a sidebar (All tasks side by side or one list; create, rename, delete with its tasks, whose upcoming occurrences leave the calendar at once; the default list kept), each list's tasks in their order with subtasks one level in, "Add a task" at the top (it stays open for the next one), edit in place (title, details, date and time or all day, deadline, repeat, star, and Advanced settings: availability, Free or Busy, and visibility, Default visibility, Public or Private, which only a task with a time has, as in Google Calendar; Busy makes the Planner plan other work around the task, in Timebox automatically and the playlist times, and the visibility goes to the working sessions the Planner writes to Google Calendar for the task planning it, so Private shows them to others as busy, without their title; a repeating task's are its series', so changing them is for all its tasks), add a subtask, drag to reorder, drag right to nest, Indent / Unindent / Move up / Move down / Move to another list (a repeating task stays in its list, as in Google Tasks), complete and reopen, a "Completed (n)" section, delete, with Undo in the snackbar (and Ctrl/⌘+Z): Google undeletes the task and its subtasks and what the Planner kept for them comes back. A repeating task's is the service's, one change of the series at a time and against the series as it is then: a next occurrence the deletion made goes again while it is still as it was made (one edited or completed since stays, the task back beside it, and Undo says so), and a series deleted This and following or All tasks comes back with the rule and the changes the cut took, and whatever changed since. Completing a task says "Task completed" with Undo too (and Ctrl/⌘+Z), wherever it is completed, as Google Tasks and Google Calendar do: it is open again, its subtasks with it, and for a repeating task the next one its completion made goes again under the same rule, the series going on from it. A task's form (in the Tasks view, over the calendar, Edit → All tasks, or one upcoming task) saves its change from what it showed when it opened, over the task, its series and Google's fields as they are then: a field it left alone keeps what another window, the service or Google's own apps gave it meanwhile (a time, a repeat cut short by This and following tasks, a title), and This task / All tasks is asked from the series as it is and from what the form changed (a new rule, or a series' own setting, is for all). A field the form changed that changed meanwhile too is not written: the form says so ("Time was changed to 1pm in another window (yours: 10am)") with Keep theirs and Save mine, and the save goes on with the choice. Advanced settings also have the task's color, and for a work or school account (Google's `hd`; Google Calendar offers these to those alone, and the Planner shows them only there) Do not disturb (the Planner's own task notifications that come during the task wait until it ends; its own notification comes at its start; Google Chat, other apps and OpenChamber's own notifications can't be muted from an extension) and "Automatically decline meetings" (only when Busy, "Unavailable for "Free" time entries" otherwise, as Google says): New and existing meetings or Only new meeting invitations, with a message; the service answers the invitations on the account's own calendar that overlap the task (and its series' upcoming occurrences, two weeks ahead) "Declined" with that message, which Google sends the organizer, at once after a change and every five minutes, each invitation once (one the user answers again stays answered). "Add a Google Drive attachment" opens a Drive picker that searches the account's Drive by name (Drive asked for first, the way Calendar and Tasks were: a sign-in for what the account has plus Drive's read-only file names); Insert attaches the files chosen (at most 25), each opens in Drive or is removed ("Remove attachment"). Google Tasks' keyboard shortcuts work on the selected task (Up/Down, Home/End, Space completes, Ctrl/⌘+] and [ indent and unindent, Ctrl/⌘+Alt+Enter adds a subtask, Ctrl/⌘(+Shift)+Up/Down move up/down or to the top/bottom, s + = star, s - unstar, . and v open its menu, Enter in a title adds a task below), Ctrl/⌘+/ lists them. While focus is on a task in the Tasks view, Google Tasks' own shortcuts stay there, as VS Code keeps its keys (Ctrl/⌘+/ and Ctrl/⌘+Z anywhere in the Tasks view); Ctrl/⌘+[ and ] are also OpenChamber's history back and forward, which reach OpenChamber from everywhere else in the Planner. Ctrl/⌘+P prints the list anywhere in the Tasks view (Print list), and opens the print preview in the calendar, as Google Tasks and Google Calendar bind it; it is also OpenChamber's command palette, which it opens from everywhere else in the Planner. Lists go in the order the user puts them (drag one, or Alt+Up/Down), on the calendar too. A shared task (assigned in a Google Doc or a Chat space) says so and links back, and neither repeats nor takes subtasks, as in Google Tasks; a task made from an email or a Keep reminder says "From Gmail" or "From Keep" and links back. Gmail messages (Google → Gmail) have "Add to Tasks": a task in the default list with the email's address in its details (Google's own link back is read-only to other apps). As in Google Tasks, wherever a task is completed (Tasks, the calendar's details or check circle, Starred, or a linked Planner task with "complete in Google"), its subtasks are completed first, and reopening a subtask reopens the task it is under first, read from Google when its list is not loaded, so a completed task never has an open subtask. An edit is all or nothing: Google takes its fields (and a new list) first, and what the Planner keeps (time, deadline, repeat and the series' template, star) changes only once it has; an edit Google refuses changes nothing, here or in Google, and its form (the Tasks view's, the calendar's or a new task's) stays open with the error and what was typed, to save again. A list's menu sorts by My order, Date (past, each day, then no date), Deadline (past, each deadline, then no deadline), Starred recently or Title, and deletes all its completed tasks after asking. Starred lists the starred tasks of every list, Recently starred or by Date; "Add a starred task" adds one to the list chosen, and a starred task's form changes its list. A task's time (and end), deadline, repeat (Daily, Weekly on …, Monthly, Yearly, or Custom… with the events' rule builder; not for subtasks or tasks with subtasks), star, color, attachments, availability, visibility, Do not disturb and declining are kept in the Planner, as Google Tasks' API lets no other app set them; the form says so and links Google's reference. A series' template carries them; its color, Do not disturb and declining are the series' (changing them is for all its tasks, as availability and visibility are), its attachments this task's or, with All tasks, the series'; an upcoming task's own attachments too (This task on the calendar), kept with the series for that day and given to the task the series makes there, as its title and time are. All tasks changes, of these as of the rest, only what the edit changed, over the series as it is then. A repeating task's series keeps its own template (title, details, time, deadline and schedule): completing an occurrence, here or in Google (seen on a read), makes the next one from it in the same list, on the series' next date after the one it put this occurrence on, unless the series has it already (a task that only shares the title and the date is never taken for it, and a task repeating in Google itself as well as in the Planner would get one from each). The service makes it, for every window of its OpenChamber at once: it changes one series at a time and keeps the next occurrence's link in the same step as it makes it, so two windows completing (or deleting) the same occurrence at the same moment make one between them, the second window getting the first one's, and a window asking again later gets that one too. Every other change of a series goes through the service the same way, worked out from the series as it is when it is written, never from what a window last saw: what a task is made with is worked out again once Google has made it (a change written meanwhile, by a window not reloaded since an update or a sync, goes to Google too, and a task the series no longer wants is deleted again), so an edit saved in one window while another completes the occurrence before it is kept, and the one next task carries it. An occurrence is told by the date its series puts it on, not by the date it shows on: one moved alone (This task) onto another occurrence's day shows beside that one, in Day, Week and Month, as two tasks of a series do in Google Calendar, and completing or deleting either makes the next one by its own date and leaves the other as it is. Editing one asks This task (that occurrence alone, in Google and in the Planner; the series and its schedule stay) or All tasks (the series, then this occurrence to match; a new rule or date starts the schedule there; a new rule is for all), as Google Calendar asks; deleting one asks This task (the series goes on), This and following tasks (the series ends the day before it, by the date the series put it on: the tasks before it, open, completed or upcoming, stay as they were, and none is made from that day on) or All tasks (the series goes, its completed tasks too, deleted in Google a few seconds on when there are many), as Google Calendar asks; the service does the last two the same way, one change of the series at a time. Deleting This task is all or nothing too: the series makes its next one first (from its template, on its next date, with what is kept for it), and only then is this one deleted in Google; when Google refuses the next one nothing is deleted and the series stays as it was, to delete again (a completed one whose next Google refused is made on the next read, its series kept meanwhile), and when Google refuses the delete once the next one is made, both stay and the Planner says so, as the delete may have reached Google: deleting it again finishes, with no second next one. Its upcoming occurrences changed or deleted alone on the calendar (This task) are kept with the series as its template is, by the date the series puts each on, and carried from one occurrence to the next: the series passes over a deleted date and makes an edited one with its own title, details, date, time and deadline. An edit puts what it changed over the occurrence as it is then, so two windows editing one keep what each changed (the same field changed in both is asked about, as in a task's form), and one deleted meanwhile stays deleted; one the series has made meanwhile is changed as that task, in Google too (deleted, its next one is made first); a date the series no longer puts one on (cut by This and following tasks, or off a new rule) is refused. All tasks keeps them (an edited one keeps what it changed and takes the rest), and changes what the edit changed over the series as it is then (a rule it left alone stays, with an end This and following tasks gave it meanwhile); a new rule or start drops those no longer on its schedule; when the task it was made from was completed meanwhile, the edit is for the series from its next task on, which takes the new title and details in Google; a series kept before templates takes its template from its open occurrence when first seen (written by the window that sees it first; were its next task linked in another window at that moment, the next completion finds that task again rather than making another). A series' open task deleted in Google's own apps is taken as This task deleted there, once a full read of its list no longer has it: the series goes on from its next one; one moved to another list there is followed. A next task made, or one changed, in another window or by the service shows on this window's calendar once it has the plan (it looks every 5 s), Google's tasks read again then. As in Google Tasks, a repeating task has no subtasks and is none, and a task with subtasks does not repeat: Add a subtask, Indent and Repeat are unavailable there, with the reason, and a drag does not nest under it. Changes made in Google Tasks come in every two minutes and when the window comes back. Each task shows the Planner task planning it; plan it today or tomorrow from its menu, or drag it onto a day or the calendar. In Today's panel, a list's open tasks to plan as before. A linked task and its Google task stay in step both ways: title, details and date (the task's due date here), merged three ways against what both sides last agreed on (kept on the link): a field changed on one side takes that side's value; changed on both, the newer change wins (Google's `updated` against the Planner's last edit of that field, from the task's activity). The link follows its task to another list, moved here or in Google (a read finds it there; one Google gave a new id is found by what it last said); every write goes to the list the task is in now, a stale list is looked up once and the write retried there, and a write that still fails says so, with the Planner undoing a completion Google refused and marking a task Google no longer has. Completing or reopening it here does the same there (complete, ask or leave it); a completion in Google completes it here (setting); planning it on a day makes it due that day; add any task to Google Tasks from its detail. Home and Today show a linked task's kept time, deadline, repeat and star. |
| Gmail | Inbox, unread, starred or any Gmail search, a page at a time ("Load more messages"); a message becomes a task with its sender and snippet, linked back to the thread (read-only); so does a message's address pasted into a new task, where Gmail's address names the message (see below). |
| Agents | Assign a task to an agent, as in GitHub or Linear: "Assign to…" (task detail's Assignee, a card's menu, Agent on a Linear or GitHub issue row) with a search box, presets and OpenCode's agents in sections with avatars, the current assignees checked, arrows and Enter; typing a model's name offers an agent on that model, kept as a preset. The agents are OpenCode's primary agents (build, plan, and custom ones from its global config folder or the project's `.opencode/`), each on its own model, and the presets named in Settings → Agents (an agent and a model, such as "Build · Claude"). Each assignee is an OpenCode command, `oc-planner-<id>.md` in OpenCode's global `command/` folder, whose frontmatter names the agent and model and whose template is the arguments (a preset's stays with the preset; an agent's goes a few minutes after its last use, so OpenChamber's `/` menu does not keep one for every agent); the chat starts with `/oc-planner-<id> <instructions>`, so OpenCode switches to that agent and model (`` !` `` in the instructions is defused, as OpenCode runs it as shell). The assignee works in a new worktree on Linear's branch name or `planner/<title>` (made first, with an empty "Worktree for …" chat, so OpenCode has loaded the commands there before the first message) and is told to commit, push and open a pull request with `gh pr create` that links the issue; the run follows that pull request through gh and through the pull requests linked to the chat (Open, Draft, Merged, Closed), and a merged one offers to complete the task. The run keeps its assignee, shown on the card, in the task detail and on the Agents page, which filters by it. Or send a task to an agent (any assignee, or OpenChamber's default) in a project folder or a new or existing worktree; the task travels as a chip; runs show working, has a question, needs permission, ready for review, failed; Accept and complete is the user's call; Agents page; Work Status line; rail badge. From a chat: "Add to Planner" on a message, "Track chat in Planner", `/task`, `/today`. |
| Assistant | Ask Planner: the request and a compact plan go to the Small Model; known operations on known tasks only; preview, apply, undo. |
| Sync | Git remote for the data repository (a private GitHub repo or any git URL); sync after changes and every 5 minutes; Sync now. |

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
| Delete → Undo (7675690) | Done now | The snackbar's Undo, and Ctrl/⌘+Z: Google undeletes it with its subtasks, kept fields come back; a repeating task's through the service, against the series as it is then (`GoogleSeries.undo`) | TC inventory, `tasksInventory.test.ts`, `gtaskSeries.test.ts` |
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
| Google Calendar, Google Tasks | | Round 11 | [Google's limits, one by one](#googles-limits-one-by-one) |
| Daily planning's sources | | | The same panels as the board's (Linear, GitHub, Gmail, Google Tasks), so the same paging; its meetings are the day's events |

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
| A Google Calendar event (`calendar.google.com/calendar/event?eid=…`, `…/r/eventedit/<eid>`) | Not documented: events come in from the calendar ("Add to tasks"), so a pasted event address is any other page | Its `eid` names the event and its calendar: the event, looked up in the connected accounts, is planned as "Plan as task" plans it (its title, its length as planned time, when it is), linked back to it; not found: a task linked to the page |
| Any other page | "Tasks from URL": a task with a backlink to the page | A task titled from the address (`host › path`; no page is fetched), the page as its link (Open link, Unlink in its details); `http` pages too |
| A tool that is not connected | Sunsama offers to connect it | Linear and GitHub say how to connect; the task is linked to the page meanwhile |

Sunsama's GitHub page also surfaces "the work you did in GitHub (comments, PRs, discussions)" in
the end-of-day review (Daily Highlights); the Planner's highlights do not read GitHub yet.

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
