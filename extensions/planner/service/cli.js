// service/assistant/cli.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// src/domain/core/dates.ts
var DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
var isDateKey = (value) => {
  if (typeof value !== "string")
    return false;
  const match = DATE_KEY.exec(value);
  if (!match)
    return false;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};
var toUtc = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
var fromUtc = (date) => date.toISOString().slice(0, 10);
var addDays = (key, days) => {
  const date = toUtc(key);
  date.setUTCDate(date.getUTCDate() + days);
  return fromUtc(date);
};
var weekday = (key) => toUtc(key).getUTCDay();
var WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
var MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
var weekdayName = (key) => WEEKDAY_NAMES[weekday(key)];
var zonedFormatters = new Map;
var zonedFormatter = (timeZone) => {
  let formatter = zonedFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    zonedFormatters.set(timeZone, formatter);
  }
  return formatter;
};
var zonedFields = (instant, timeZone) => {
  const fields = {};
  for (const part of zonedFormatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== "literal")
      fields[part.type] = Number(part.value);
  }
  return { year: fields.year, month: fields.month, day: fields.day, hour: fields.hour % 24, minute: fields.minute, second: fields.second };
};
var zonedDateMinutes = (iso, timeZone) => {
  const instant = typeof iso === "number" ? iso : Date.parse(iso);
  const f = zonedFields(instant, timeZone);
  return { date: `${f.year}-${String(f.month).padStart(2, "0")}-${String(f.day).padStart(2, "0")}`, minutes: f.hour * 60 + f.minute + f.second / 60 };
};
var formatMinutes = (minutes) => {
  if (minutes == null || !Number.isFinite(minutes))
    return "";
  const total = Math.max(0, Math.round(minutes));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};
var SHORT_MONTHS = MONTH_NAMES.map((month) => month.slice(0, 3));
var parts = (key) => ({ year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)), day: Number(key.slice(8)) });
var longDay = (key) => `${WEEKDAY_NAMES[weekday(key)]}, ${MONTH_NAMES[parts(key).month - 1]} ${parts(key).day}`;

// src/domain/core/types.ts
var BACKLOG_BUCKETS = [
  { id: "next-weeks", label: "Someday in the next week or two" },
  { id: "next-month", label: "Someday in the next month" },
  { id: "next-quarter", label: "Someday in the next quarter" },
  { id: "next-year", label: "Someday in the next year" },
  { id: "someday", label: "Someday" },
  { id: "never", label: "Never" }
];
var MEETING_EXCLUSIONS = ["noAttendees", "nonBlocking", "oooHold", "unconfirmed", "multiDayAllDay"];
var ritualKey = (ritual, date) => `${ritual}:${date}`;
var DEFAULT_SETTINGS = {
  timezone: null,
  workloadMinutes: 6 * 60,
  archiveAfterRollovers: 7,
  weekStartsOn: 1,
  plannedAsActual: true,
  workdayStart: 9 * 60,
  workdayEnd: 18 * 60,
  linearOnComplete: "ask",
  linearOnPlan: "nothing",
  linearImportCompletion: false,
  linearLayout: "list",
  linearGroupBy: "status",
  linearOrderBy: "priority",
  linearDisplay: { subGroupBy: "none", orderReverse: false, showCompleted: "none", showSubIssues: true, showEmptyGroups: false, showEmptyColumns: true, properties: ["id", "status", "priority", "labels", "project", "due", "assignee", "created"] },
  suggestFromHistory: true,
  pomodoroMinutes: 25,
  breakMinutes: 5,
  googleTimebox: null,
  googleTasksOnComplete: "complete",
  googleTasksImportCompletion: true,
  googleTasksDueFromPlan: true,
  googleTasksOnCalendar: true,
  googleTaskNotifications: true,
  googleCalendarsIntroduced: [],
  agentPresets: [],
  gmailOnImport: [],
  gmailOnComplete: [],
  gmailImportPrompt: false,
  gmailCompletePrompt: false,
  emailClient: "gmail",
  linearImportPrompt: false,
  meetingImport: "prompt",
  meetingCalendars: [],
  meetingExclusions: [...MEETING_EXCLUSIONS],
  meetingAutoComplete: "always",
  meetingChannels: {},
  channelTimebox: {}
};

// src/domain/core/selectors.ts
var isLive = (task) => !task.deletedAt && !task.archivedAt;
var byPosition = (a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt);
var samePlacement = (a, b) => a.kind === "day" ? b.kind === "day" && a.date === b.date : b.kind === "backlog" && a.bucket === b.bucket;
var tasksIn = (state, placement) => Object.values(state.tasks).filter((task) => isLive(task) && samePlacement(task.placement, placement)).sort(byPosition);
var tasksForDay = (state, date) => tasksIn(state, { kind: "day", date });
var backlogTasks = (state, bucket) => tasksIn(state, { kind: "backlog", bucket });
var plannedTotal = (tasks) => tasks.reduce((sum, task) => sum + (task.plannedMinutes ?? 0), 0);
var entryIndex = new WeakMap;
var entriesByTask = (state) => {
  let index = entryIndex.get(state.entries);
  if (!index) {
    index = new Map;
    for (const entry of Object.values(state.entries)) {
      const list = index.get(entry.taskId) ?? [];
      list.push(entry);
      index.set(entry.taskId, list);
    }
    for (const list of index.values())
      list.sort((a, b) => a.start.localeCompare(b.start));
    entryIndex.set(state.entries, index);
  }
  return index;
};
var entriesFor = (state, taskId) => entriesByTask(state).get(taskId) ?? [];
var trackedMinutes = (state, taskId, now) => {
  let ms = 0;
  for (const entry of entriesFor(state, taskId))
    ms += Date.parse(entry.end) - Date.parse(entry.start);
  if (now !== undefined && state.timer?.taskId === taskId)
    ms += Math.max(0, now - Date.parse(state.timer.startedAt));
  return ms / 60000;
};
var actualMinutes = (state, task, now) => {
  const tracked = trackedMinutes(state, task.id, now);
  if (tracked > 0)
    return tracked;
  return state.settings.plannedAsActual && task.completedAt && task.plannedMinutes ? task.plannedMinutes : 0;
};
var blocksOnDay = (state, date) => {
  const zone = state.settings.timezone ?? "UTC";
  return Object.values(state.blocks).filter((block) => {
    const task = state.tasks[block.taskId];
    return task && !task.deletedAt && !task.archivedAt && zonedDateMinutes(block.start, zone).date === date;
  }).sort((a, b) => a.start.localeCompare(b.start));
};
var blocksFor = (state, taskId) => Object.values(state.blocks).filter((block) => block.taskId === taskId).sort((a, b) => a.start.localeCompare(b.start));
var liveChannels = (state) => Object.values(state.channels).filter((channel) => !channel.deletedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

// src/domain/google/rrule.ts
var KNOWN = new Set(["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "BYMONTH", "COUNT", "UNTIL"]);

// src/domain/core/events.ts
var SERVICE_ONLY_TYPES = new Set(["tasks.rolledOver", "tasks.recurred"]);
var BUCKET_IDS = new Set(BACKLOG_BUCKETS.map((bucket) => bucket.id));
var PRIORITY_VALUES = new Set(["urgent", "high", "medium", "low"]);
var MAX_ENTRY_MS = 24 * 60 * 60 * 1000;

// src/domain/plan/undo.ts
var IGNORED = {
  tasks: new Set(["updatedAt", "rolloverCount"]),
  blocks: new Set(["google"])
};

// src/domain/plan/suggest.ts
var STOP_WORDS = new Set(["the", "a", "an", "to", "for", "of", "and", "or", "in", "on", "with", "at", "by", "from", "my", "your", "this", "that", "is", "be", "do", "up", "it"]);

// src/domain/plan/rituals.ts
var ritualRecord = (state, ritual, date) => state.rituals[ritualKey(ritual, date)] ?? {};
var completedOnDay = (state, date) => Object.values(state.tasks).filter((task) => task.completedOn === date && !task.deletedAt).sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""));
var highlightItems = (state, date) => {
  const saved = ritualRecord(state, "highlights", date).items ?? [];
  const live = saved.filter((item) => !item.taskId || state.tasks[item.taskId] && !state.tasks[item.taskId].deletedAt);
  const known = new Set(saved.map((item) => item.taskId).filter(Boolean));
  const fresh = completedOnDay(state, date).filter((task) => !known.has(task.id)).map((task) => ({ id: task.id, text: task.title, taskId: task.id, starred: false }));
  return [...live, ...fresh];
};

// src/domain/assistant/assistant.ts
var BUCKETS = new Set(BACKLOG_BUCKETS.map((bucket) => bucket.id));
var clock = (minutes) => {
  const whole = Math.floor(minutes);
  return `${String(Math.floor(whole / 60) % 24).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
};
var live = (state, id) => {
  const task = typeof id === "string" ? state.tasks[id] : undefined;
  return task && !task.deletedAt ? task : null;
};
var liveFolders = (state) => Object.values(state.folders).filter((folder) => !folder.deletedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
var dayLabel = (date, today) => date === today ? "today" : date === addDays(today, 1) ? "tomorrow" : `${weekdayName(date)} ${date}`;
var taskLine = (state, task) => {
  const channel = task.channelId ? state.channels[task.channelId]?.name : null;
  const folder = task.folderId ? state.folders[task.folderId] : null;
  const extras = [task.plannedMinutes ? formatMinutes(task.plannedMinutes) : null, channel ? `#${channel}` : null, folder && !folder.deletedAt ? `folder "${folder.name}"` : null, task.priority, task.dueDate ? `due ${task.dueDate}` : null, task.source ? `${task.source.kind} ${task.source.key}` : null, task.subtasks.length ? `${task.subtasks.filter((subtask) => subtask.done).length}/${task.subtasks.length} subtasks` : null].filter(Boolean);
  return `- [${task.id}] ${task.completedAt ? "(done) " : ""}${task.title}${extras.length ? ` (${extras.join(", ")})` : ""}`;
};
var span = (start, end, zone) => `${clock(zonedDateMinutes(start, zone).minutes)}–${clock(zonedDateMinutes(end, zone).minutes)}`;
var dayText = (state, date, today, events, zone, now) => {
  const tasks = tasksForDay(state, date);
  const open = tasks.filter((task) => !task.completedAt);
  const when = date === today ? ` (today${now ? `, ${now} now` : ""})` : date === addDays(today, 1) ? " (tomorrow)" : "";
  const lines = [`${longDay(date)}, ${date}${when}: ${tasks.length} task${tasks.length === 1 ? "" : "s"}, ${open.length} open, ${formatMinutes(plannedTotal(open))} planned for the open ones`];
  lines.push(...tasks.length ? tasks.map((task) => taskLine(state, task)) : ["- (nothing planned)"]);
  const blocks = blocksOnDay(state, date);
  if (blocks.length)
    lines.push("Sessions on the calendar:", ...blocks.map((block) => `- ${span(block.start, block.end, zone)} [${block.taskId}] ${state.tasks[block.taskId]?.title ?? ""}`));
  if (events === null)
    lines.push("Calendar events: not read (no calendar is connected, or it did not answer)");
  else if (events.length)
    lines.push("Calendar events:", ...events.map((event) => `- ${event.allDay ? "all day" : span(event.start, event.end, zone)} ${event.title}${event.busy ? "" : " (free)"}`));
  else
    lines.push("Calendar events: none");
  return lines.join(`
`);
};
var weekText = (state, today, eventsOf, zone, now) => {
  const parts = [];
  for (let offset = 0;offset < 7; offset++) {
    const date = addDays(today, offset);
    if (offset > 1 && tasksForDay(state, date).length === 0 && !eventsOf(date)?.length)
      continue;
    parts.push(dayText(state, date, today, eventsOf(date), zone, now));
  }
  return parts.join(`

`);
};
var BACKLOG_SHOWN = 100;
var backlogText = (state) => {
  const parts = [];
  for (const bucket of BACKLOG_BUCKETS) {
    const tasks = backlogTasks(state, bucket.id);
    if (!tasks.length)
      continue;
    parts.push(`Backlog, ${bucket.label.toLowerCase()} (${bucket.id}): ${tasks.length}`, ...tasks.slice(0, BACKLOG_SHOWN).map((task) => taskLine(state, task)));
    if (tasks.length > BACKLOG_SHOWN)
      parts.push(`- … and ${tasks.length - BACKLOG_SHOWN} more (planner find <words>)`);
  }
  return parts.length ? parts.join(`
`) : "The backlog is empty.";
};
var FIND_SHOWN = 50;
var findText = (state, query, today) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length)
    return "find needs words to look for";
  const since = addDays(today, -30);
  const found = Object.values(state.tasks).filter((task) => !task.deletedAt && !task.archivedAt && (!task.completedOn || task.completedOn >= since)).filter((task) => words.every((word) => `${task.title}
${task.notes}`.toLowerCase().includes(word))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!found.length)
    return `No open task, nor one done in the last 30 days, holds "${query.trim()}".`;
  const where = (task) => task.placement.kind === "day" ? dayLabel(task.placement.date, today) : `backlog ${task.placement.bucket}`;
  return [`${found.length} task${found.length === 1 ? "" : "s"}:`, ...found.slice(0, FIND_SHOWN).map((task) => `${taskLine(state, task)} · ${where(task)}`), ...found.length > FIND_SHOWN ? [`- … and ${found.length - FIND_SHOWN} more: say more words`] : []].join(`
`);
};
var taskText = (state, taskId, today, zone) => {
  const task = live(state, taskId);
  if (!task)
    return `No task [${taskId}] in the plan.`;
  const channel = task.channelId ? state.channels[task.channelId]?.name : null;
  const where = task.placement.kind === "day" ? `${dayLabel(task.placement.date, today)} (${task.placement.date})` : `backlog ${task.placement.bucket}`;
  const lines = [
    `[${task.id}] ${task.title}`,
    `Status: ${task.archivedAt ? "archived" : task.completedAt ? `done ${task.completedOn ?? ""}`.trim() : "open"}`,
    `Planned for: ${where}`,
    `Planned time: ${task.plannedMinutes ? formatMinutes(task.plannedMinutes) : "none"}; spent: ${formatMinutes(actualMinutes(state, task))}`,
    `Channel: ${channel ? `#${channel}` : "none"}; priority: ${task.priority ?? "none"}; due: ${task.dueDate ?? "none"}`
  ];
  if (task.source)
    lines.push(`From: ${task.source.kind} ${task.source.key} ${task.source.url}${task.source.status ? ` (${task.source.status.name})` : ""}`);
  if (task.sessionRef)
    lines.push(`Chat: ${task.sessionRef.title}`);
  const blocks = blocksFor(state, task.id);
  if (blocks.length)
    lines.push("Sessions:", ...blocks.map((block) => `- ${zonedDateMinutes(block.start, zone).date} ${span(block.start, block.end, zone)}`));
  if (task.subtasks.length)
    lines.push("Subtasks:", ...task.subtasks.map((subtask) => `- [${subtask.done ? "x" : " "}] ${subtask.title}${subtask.plannedMinutes ? ` (${formatMinutes(subtask.plannedMinutes)})` : ""}`));
  lines.push(task.notes.trim() ? `Notes:
${task.notes.trim()}` : "Notes: none");
  return lines.join(`
`);
};
var channelsText = (state) => {
  const channels = liveChannels(state);
  const folders = liveFolders(state);
  return [
    channels.length ? `Channels:
${channels.map((channel) => `#${channel.name} (${channel.context})`).join(`
`)}` : "No channels.",
    folders.length ? `Backlog folders:
${folders.map((folder) => `"${folder.name}"`).join(`
`)}` : "No backlog folders."
  ].join(`

`);
};
var highlightsText = (state, date, today) => {
  const items = highlightItems(state, date).filter((item) => !item.hidden);
  const ordered = [...items.filter((item) => item.starred), ...items.filter((item) => !item.starred)];
  const tracked = completedOnDay(state, date).reduce((sum, task) => sum + actualMinutes(state, task), 0);
  const record = ritualRecord(state, "highlights", date);
  return [
    `Daily highlights, ${longDay(date)}, ${date}${date === today ? " (today)" : date === addDays(today, -1) ? " (yesterday)" : ""}: ${ordered.length} item${ordered.length === 1 ? "" : "s"}, ${formatMinutes(tracked)} tracked`,
    ...ordered.length ? ordered.map((item) => `- ${item.starred ? "(starred) " : ""}${item.text}${item.url ? ` (${item.url})` : ""}`) : ["- (nothing done yet)"],
    `Reflection: ${record.reflection?.trim() || "none"}`,
    `Summary: ${record.summary?.trim() || "none"}`
  ].join(`
`);
};

// service/assistant/cli.ts
var HELP = (today) => `planner: the Planner's command line, for an agent working on the person's plan (Ask Planner in OpenChamber).
${today}
Tasks are named by the id in [brackets]; days are dates; times are 24-hour HH:MM in the plan's time zone.

Read
  planner show [today|tomorrow|YYYY-MM-DD|week|backlog]  a day's tasks, sessions and calendar events (default today)
  planner find <words>                                   open tasks, and ones done in 30 days, holding every word
  planner task <id>                                      one task in full: notes, subtasks, sessions, where it is from
  planner channels                                       the channels a task can be in, and the backlog's folders
  planner highlights [D]                                 a day's Daily highlights: what got done, its reflection and summary

Change (each prints what it did and its change id; nothing is ever deleted)
  planner add <title> [--when W] [--minutes N] [--channel NAME] [--priority P] [--due D] [--notes TEXT] [--folder NAME]
  planner move <id>... --to W
  planner done <id>...     planner reopen <id>...     planner archive <id>...
  planner estimate <id> <minutes|none>
  planner channel <id> <name|none>
  planner rename <id> <title>
  planner notes <id> <text> [--append]
  planner due <id> <D|none>
  planner priority <id> <urgent|high|medium|low|none>
  planner subtask <id> <title> [--minutes N]
  planner schedule <id> <HH:MM> [--day D] [--minutes N]   a working session on the calendar; plans the task that day
  planner summary <D> <text>                              the Daily highlights summary of a day
  planner undo [<change>]                                 take back this chat's last change, or the one named

W: today, tomorrow, a date YYYY-MM-DD, or a backlog bucket: next-weeks, next-month, next-quarter, next-year, someday, never.
D: today, tomorrow, yesterday or a date YYYY-MM-DD. P: urgent, high, medium or low. A folder is a backlog folder; a
task planned for a day keeps its folder.

Work like this: read before you change; change only what the person asked for; when a request is unclear, ask them
instead of guessing; archive what they no longer want; end with a short list of what you changed.`;

class Stop extends Error {
}
var fail = (message) => {
  throw new Stop(message);
};
var agentFile = () => process.env.PLANNER_AGENT_FILE || join(process.env.HOME || homedir(), ".local", "share", "openchamber-planner", "agent.json");
var readAgent = () => {
  try {
    const agent = JSON.parse(readFileSync(agentFile(), "utf8"));
    if (typeof agent.url === "string" && typeof agent.key === "string")
      return { url: agent.url, key: agent.key };
  } catch {}
  return fail("the Planner has not started on this machine yet: open the Planner in OpenChamber, then run this again");
};
var call = async (agent, method, path, body) => {
  let response;
  try {
    response = await fetch(`${agent.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${agent.key}`, ...body === undefined ? {} : { "Content-Type": "application/json" } },
      ...body === undefined ? {} : { body: JSON.stringify(body) }
    });
  } catch {
    return fail("the Planner is not running: open the Planner in OpenChamber, then run this again");
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (response.status === 401)
    fail("the Planner did not take its key: it may have restarted; run this again");
  if (!response.ok)
    fail(data?.error ?? `the Planner answered ${response.status}`);
  return data;
};
var plan = async (agent) => {
  const answer = await call(agent, "GET", "/agent/state");
  if (!answer.today)
    fail("the plan has no time zone yet: open the Planner once");
  return answer;
};
var calendar = async (agent, from, to) => (await call(agent, "GET", `/agent/calendar?from=${from}&to=${to}`)).days;
var parse = (args) => {
  const words = [];
  const flags = {};
  for (let index = 0;index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--") || arg === "--") {
      words.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (name === "append")
      flags.append = "yes";
    else if (inline !== undefined)
      flags[name] = inline;
    else if (index + 1 < args.length)
      flags[name] = args[++index];
    else
      fail(`--${name} needs a value`);
  }
  return { words, flags };
};
var minutesArg = (value, what = "minutes") => {
  if (value === undefined)
    return;
  if (value === "none")
    return null;
  const minutes = /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(minutes) ? minutes : fail(`${what} must be a whole number of minutes, or none`);
};
var noneOr = (value) => value === "none" ? null : value;
var need = (value, usage) => value ?? fail(`usage: planner ${usage}`);
var opsOf = (command, words, flags) => {
  const [id, ...rest] = words;
  const all = (usage) => words.length ? words : fail(`usage: planner ${usage}`);
  switch (command) {
    case "add": {
      const title = words.join(" ").trim() || fail("usage: planner add <title> [--when W] [--minutes N] [--channel NAME] [--priority P] [--due D] [--notes TEXT]");
      return [{ op: "add", title, when: flags.when ?? null, minutes: minutesArg(flags.minutes) ?? null, channel: flags.channel ?? null, priority: flags.priority ?? null, due: flags.due ?? null, notes: flags.notes ?? null, folder: flags.folder ?? null }];
    }
    case "move": {
      const to = flags.to ?? flags.when ?? fail("usage: planner move <id>... --to W");
      return all("move <id>... --to W").map((taskId) => ({ op: "move", taskId, when: to }));
    }
    case "done":
    case "reopen":
    case "archive":
      return all(`${command} <id>...`).map((taskId) => ({ op: command, taskId }));
    case "estimate":
      return [{ op: "estimate", taskId: need(id, "estimate <id> <minutes|none>"), minutes: minutesArg(need(rest[0], "estimate <id> <minutes|none>")) }];
    case "channel":
      return [{ op: "channel", taskId: need(id, "channel <id> <name|none>"), channel: noneOr(need(rest[0], "channel <id> <name|none>")) }];
    case "rename":
      return [{ op: "rename", taskId: need(id, "rename <id> <title>"), title: rest.join(" ").trim() || fail("usage: planner rename <id> <title>") }];
    case "notes":
      return [{ op: "notes", taskId: need(id, "notes <id> <text> [--append]"), notes: rest.join(" "), append: flags.append === "yes" }];
    case "due":
      return [{ op: "due", taskId: need(id, "due <id> <D|none>"), due: noneOr(need(rest[0], "due <id> <D|none>")) }];
    case "priority":
      return [{ op: "priority", taskId: need(id, "priority <id> <urgent|high|medium|low|none>"), priority: noneOr(need(rest[0], "priority <id> <urgent|high|medium|low|none>")) }];
    case "subtask":
      return [{ op: "subtask", taskId: need(id, "subtask <id> <title> [--minutes N]"), title: rest.join(" ").trim() || fail("usage: planner subtask <id> <title> [--minutes N]"), minutes: minutesArg(flags.minutes) ?? null }];
    case "schedule":
      return [{ op: "schedule", taskId: need(id, "schedule <id> <HH:MM> [--day D] [--minutes N]"), start: need(rest[0], "schedule <id> <HH:MM> [--day D] [--minutes N]"), date: flags.day ?? null, minutes: minutesArg(flags.minutes) ?? null }];
    case "summary":
      return [{ op: "summary", date: need(id, "summary <D> <text>"), text: rest.join(" ").trim() || fail("usage: planner summary <D> <text>") }];
  }
  return fail(`unknown command "${command}": planner help lists them`);
};
var run = async (args) => {
  const [command = "help", ...more] = args;
  const { words, flags } = parse(more);
  const session = process.env.OPENCODE_SESSION_ID || null;
  if (command === "help" || command === "--help" || command === "-h") {
    let today = "";
    try {
      const { today: date, zone, now } = await plan(readAgent());
      today = `Today is ${weekdayName(date)} ${date}, ${now} now (${zone}).`;
    } catch (error) {
      today = `(${error instanceof Stop ? error.message : String(error)})`;
    }
    return HELP(today);
  }
  const agent = readAgent();
  if (command === "show") {
    const { state, today, zone, now } = await plan(agent);
    const which = words[0] ?? "today";
    if (which === "backlog")
      return backlogText(state);
    if (which === "week") {
      const days = await calendar(agent, today, addDays(today, 6));
      return weekText(state, today, (date) => days[date] ?? null, zone, now);
    }
    const date = which === "today" ? today : which === "tomorrow" ? addDays(today, 1) : isDateKey(which) ? which : fail("usage: planner show [today|tomorrow|YYYY-MM-DD|week|backlog]");
    const days = await calendar(agent, date, date);
    return dayText(state, date, today, days[date] ?? null, zone, now);
  }
  if (command === "find") {
    const { state, today } = await plan(agent);
    return findText(state, words.join(" "), today);
  }
  if (command === "task") {
    const { state, today, zone } = await plan(agent);
    return taskText(state, need(words[0], "task <id>").replace(/^\[|\]$/g, ""), today, zone);
  }
  if (command === "channels")
    return channelsText((await plan(agent)).state);
  if (command === "highlights") {
    const { state, today } = await plan(agent);
    const which = words[0] ?? "today";
    const date = which === "today" ? today : which === "yesterday" ? addDays(today, -1) : isDateKey(which) ? which : fail("usage: planner highlights [today|yesterday|YYYY-MM-DD]");
    return highlightsText(state, date, today);
  }
  if (command === "undo") {
    const answer = await call(agent, "POST", "/agent/undo", { session, ...words[0] ? { change: words[0] } : {} });
    return `Took back: ${answer.undone}`;
  }
  const unbracket = (word, index) => !["add", "summary"].includes(command) && (index === 0 || ["move", "done", "reopen", "archive"].includes(command)) ? word.replace(/^\[|\]$/g, "") : word;
  const ops = opsOf(command, words.map(unbracket), flags);
  const answer = await call(agent, "POST", "/agent/ops", { ops, session });
  return `${answer.change.label} (change ${answer.change.id})`;
};
try {
  console.log(await run(process.argv.slice(2)));
} catch (error) {
  console.error(`planner: ${error instanceof Stop ? error.message : error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
