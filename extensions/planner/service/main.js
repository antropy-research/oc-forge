// service/main.ts
import http2 from "node:http";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname3, join as join4 } from "node:path";

// service/store.ts
import { execFile } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

// src/domain/types.ts
var BACKLOG_BUCKETS = [
  { id: "next-weeks", label: "Someday in the next week or two" },
  { id: "next-month", label: "Someday in the next month" },
  { id: "next-quarter", label: "Someday in the next quarter" },
  { id: "next-year", label: "Someday in the next year" },
  { id: "someday", label: "Someday" },
  { id: "never", label: "Never" }
];
var SOURCE_NAMES = { linear: "Linear", github: "GitHub", gtask: "Google Tasks", email: "Gmail" };
var LINEAR_GROUPS = ["status", "priority", "project", "team", "assignee", "workspace", "none", "cycle", "label"];
var LINEAR_ORDERS = ["priority", "updated", "due", "identifier", "status", "manual", "created"];
var LINEAR_COMPLETED = ["all", "day", "week", "month", "3months", "6months", "year", "none"];
var LINEAR_PROPERTIES = ["id", "status", "priority", "assignee", "labels", "project", "cycle", "estimate", "due", "created", "updated"];
var RITUALS = ["planning", "shutdown", "highlights", "weeklyPlanning", "weeklyReview"];
var googleTaskKey = (account, taskId) => `${account}
${taskId}`;
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
  googleCalendarsIntroduced: [],
  agentPresets: []
};
var emptyState = () => ({
  version: 0,
  tasks: {},
  channels: {},
  entries: {},
  timer: null,
  blocks: {},
  calendars: {},
  objectives: {},
  rituals: {},
  series: {},
  runs: {},
  folders: {},
  settings: { ...DEFAULT_SETTINGS },
  googleTasks: {}
});

// src/domain/dates.ts
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
var todayIn = (timeZone, now = new Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
var isValidTimeZone = (timeZone) => {
  if (typeof timeZone !== "string" || !timeZone)
    return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
};
var addDays = (key, days) => {
  const date = toUtc(key);
  date.setUTCDate(date.getUTCDate() + days);
  return fromUtc(date);
};
var daysBetween = (a, b) => Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86400000);
var weekday = (key) => toUtc(key).getUTCDay();
var startOfWeek = (key, weekStartsOn) => {
  const offset = (weekday(key) - weekStartsOn + 7) % 7;
  return addDays(key, -offset);
};
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
var offsetAt = (instant, timeZone) => {
  const f = zonedFields(instant, timeZone);
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - Math.floor(instant / 1000) * 1000;
};
var zonedDateMinutes = (iso, timeZone) => {
  const instant = typeof iso === "number" ? iso : Date.parse(iso);
  const f = zonedFields(instant, timeZone);
  return { date: `${f.year}-${String(f.month).padStart(2, "0")}-${String(f.day).padStart(2, "0")}`, minutes: f.hour * 60 + f.minute + f.second / 60 };
};
var instantAt = (date, minutes, timeZone) => {
  const [y, m, d] = date.split("-").map(Number);
  const local = Date.UTC(y, m - 1, d, 0, 0, 0) + Math.round(minutes * 60000);
  let guess = local - offsetAt(local, timeZone);
  guess = local - offsetAt(guess, timeZone);
  return new Date(guess).toISOString();
};

// src/domain/selectors.ts
var POSITION_STEP = 1024;
var isLive = (task) => !task.deletedAt && !task.archivedAt;
var byPosition = (a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt);
var samePlacement = (a, b) => a.kind === "day" ? b.kind === "day" && a.date === b.date : b.kind === "backlog" && a.bucket === b.bucket;
var tasksIn = (state, placement) => Object.values(state.tasks).filter((task) => isLive(task) && samePlacement(task.placement, placement)).sort(byPosition);
var tasksForDay = (state, date) => tasksIn(state, { kind: "day", date });
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
var edgePosition = (state, placement, edge) => {
  const list = tasksIn(state, placement);
  if (list.length === 0)
    return POSITION_STEP;
  return edge === "top" ? list[0].position - POSITION_STEP : list[list.length - 1].position + POSITION_STEP;
};

// src/domain/reducer.ts
var zoneOf = (state) => state.settings.timezone ?? "UTC";
var blockDate = (state, start) => zonedDateMinutes(start, zoneOf(state)).date;
var syncTaskToBlocks = (state, taskId, at, changedStart) => {
  const task = state.tasks[taskId];
  if (!task)
    return;
  const blocks = Object.values(state.blocks).filter((block) => block.taskId === taskId);
  let next = task;
  if (blocks.length > 0) {
    const minutes = Math.round(blocks.reduce((sum, block) => sum + (Date.parse(block.end) - Date.parse(block.start)), 0) / 60000);
    if (minutes !== task.plannedMinutes)
      next = { ...next, plannedMinutes: minutes };
  }
  if (changedStart) {
    const date = blockDate(state, changedStart);
    if (next.placement.kind !== "day" || next.placement.date !== date) {
      const last = Object.values(state.tasks).reduce((max, other) => other.placement.kind === "day" && other.placement.date === date ? Math.max(max, other.position) : max, 0);
      next = { ...next, placement: { kind: "day", date }, position: last + 1024, rolloverCount: 0, archivedAt: null, folderId: null };
    }
  }
  if (next !== task)
    state.tasks[taskId] = { ...next, updatedAt: at };
};
var touch = (state, taskId, at, change) => {
  const task = state.tasks[taskId];
  if (!task)
    return;
  state.tasks[taskId] = { ...change(task), updatedAt: at };
};
var stopTimer = (state, at, entryId) => {
  const timer = state.timer;
  if (!timer)
    return;
  state.timer = null;
  if (Date.parse(at) > Date.parse(timer.startedAt)) {
    state.entries[entryId] = { id: entryId, taskId: timer.taskId, start: timer.startedAt, end: at, source: "timer" };
  }
};
var stopTimerFor = (state, taskId, event) => {
  if (state.timer?.taskId === taskId)
    stopTimer(state, event.at, event.id);
};
var createTask = (state, input, at) => {
  if (state.tasks[input.id])
    return;
  state.tasks[input.id] = {
    id: input.id,
    title: input.title.trim(),
    notes: input.notes ?? "",
    plannedMinutes: input.plannedMinutes ?? null,
    priority: input.priority ?? null,
    dueDate: input.dueDate ?? null,
    placement: input.placement,
    position: input.position,
    completedAt: null,
    completedOn: null,
    rolloverCount: 0,
    archivedAt: null,
    deletedAt: null,
    createdAt: at,
    updatedAt: at,
    channelId: input.channelId ?? null,
    folderId: input.folderId ?? null,
    objectiveId: input.objectiveId ?? null,
    subtasks: input.subtasks ?? [],
    source: input.source ?? null,
    recurrence: input.recurrence ?? null,
    sessionRef: input.sessionRef ?? null
  };
};
var applyInto = (state, event) => {
  state.version += 1;
  switch (event.type) {
    case "task.created":
      createTask(state, event.task, event.at);
      return;
    case "task.updated":
      touch(state, event.taskId, event.at, (task) => ({
        ...task,
        ...event.patch,
        ...event.patch.title !== undefined ? { title: event.patch.title.trim() } : {}
      }));
      return;
    case "task.moved": {
      const before = state.tasks[event.taskId];
      if (before && before.placement.kind === "day" && !samePlacement(before.placement, event.placement)) {
        const source = before.placement.date;
        for (const block of Object.values(state.blocks)) {
          if (block.taskId === event.taskId && blockDate(state, block.start) === source)
            delete state.blocks[block.id];
        }
      }
      touch(state, event.taskId, event.at, (task) => ({
        ...task,
        placement: event.placement,
        position: event.position,
        rolloverCount: samePlacement(task.placement, event.placement) ? task.rolloverCount : 0,
        archivedAt: null,
        folderId: event.placement.kind === "day" ? null : task.folderId
      }));
      return;
    }
    case "task.completed":
      stopTimerFor(state, event.taskId, event);
      touch(state, event.taskId, event.at, (task) => ({ ...task, completedAt: event.at, completedOn: event.on }));
      return;
    case "task.reopened":
      touch(state, event.taskId, event.at, (task) => ({ ...task, completedAt: null, completedOn: null }));
      return;
    case "task.deleted":
      stopTimerFor(state, event.taskId, event);
      touch(state, event.taskId, event.at, (task) => ({ ...task, deletedAt: event.at }));
      return;
    case "task.restored":
      touch(state, event.taskId, event.at, (task) => ({ ...task, deletedAt: null, archivedAt: null }));
      return;
    case "task.sourceSynced":
      touch(state, event.taskId, event.at, (task) => ({
        ...task,
        source: event.source,
        ...event.title !== undefined ? { title: event.title.trim() } : {},
        ...event.notes !== undefined ? { notes: event.notes } : {},
        ...event.dueDate !== undefined ? { dueDate: event.dueDate } : {}
      }));
      return;
    case "task.archived":
      stopTimerFor(state, event.taskId, event);
      touch(state, event.taskId, event.at, (task) => ({ ...task, archivedAt: event.at }));
      return;
    case "timer.started": {
      if (!state.tasks[event.taskId] || state.timer?.taskId === event.taskId)
        return;
      stopTimer(state, event.at, `${event.id}-prev`);
      state.timer = { taskId: event.taskId, startedAt: event.at };
      return;
    }
    case "timer.stopped":
      stopTimer(state, event.at, event.id);
      return;
    case "time.logged":
      if (!state.tasks[event.entry.taskId] || state.entries[event.entry.id])
        return;
      state.entries[event.entry.id] = { ...event.entry, source: "manual" };
      return;
    case "time.deleted":
      delete state.entries[event.entryId];
      return;
    case "block.created":
      if (!state.tasks[event.block.taskId] || state.blocks[event.block.id])
        return;
      state.blocks[event.block.id] = { ...event.block };
      syncTaskToBlocks(state, event.block.taskId, event.at, event.block.start);
      return;
    case "block.updated": {
      const block = state.blocks[event.blockId];
      if (!block)
        return;
      state.blocks[event.blockId] = { ...block, start: event.start, end: event.end };
      syncTaskToBlocks(state, block.taskId, event.at, event.start);
      return;
    }
    case "block.linked": {
      const block = state.blocks[event.blockId];
      if (!block)
        return;
      const { google: _old, ...rest } = block;
      state.blocks[event.blockId] = event.google ? { ...rest, google: event.google } : rest;
      return;
    }
    case "block.deleted": {
      const block = state.blocks[event.blockId];
      if (!block)
        return;
      delete state.blocks[event.blockId];
      syncTaskToBlocks(state, block.taskId, event.at, null);
      return;
    }
    case "objective.created":
      if (!state.objectives[event.objective.id]) {
        state.objectives[event.objective.id] = { ...event.objective, carriedFrom: event.objective.carriedFrom ?? null, title: event.objective.title.trim(), completedAt: null, createdAt: event.at, deletedAt: null };
      }
      return;
    case "objective.updated": {
      const objective = state.objectives[event.objectiveId];
      if (!objective)
        return;
      state.objectives[event.objectiveId] = {
        ...objective,
        ...event.patch.title !== undefined ? { title: event.patch.title.trim() } : {},
        ...event.patch.completed !== undefined ? { completedAt: event.patch.completed ? event.at : null } : {}
      };
      return;
    }
    case "objective.deleted": {
      const objective = state.objectives[event.objectiveId];
      if (!objective)
        return;
      state.objectives[event.objectiveId] = { ...objective, deletedAt: event.at };
      for (const task of Object.values(state.tasks)) {
        if (task.objectiveId === event.objectiveId)
          state.tasks[task.id] = { ...task, objectiveId: null, updatedAt: event.at };
      }
      return;
    }
    case "ritual.saved": {
      const key = ritualKey(event.ritual, event.date);
      state.rituals[key] = { ...state.rituals[key], ...event.fields };
      return;
    }
    case "folder.created":
      if (!state.folders[event.folder.id])
        state.folders[event.folder.id] = { id: event.folder.id, name: event.folder.name.trim(), createdAt: event.at, deletedAt: null };
      return;
    case "folder.renamed": {
      const folder = state.folders[event.folderId];
      if (folder)
        state.folders[event.folderId] = { ...folder, name: event.name.trim() };
      return;
    }
    case "folder.deleted": {
      const folder = state.folders[event.folderId];
      if (!folder)
        return;
      state.folders[event.folderId] = { ...folder, deletedAt: event.at };
      for (const task of Object.values(state.tasks)) {
        if (task.folderId === event.folderId)
          state.tasks[task.id] = { ...task, folderId: null, updatedAt: event.at };
      }
      return;
    }
    case "run.started":
      if (state.runs[event.run.id] || !state.tasks[event.run.taskId])
        return;
      state.runs[event.run.id] = { ...event.run, startedAt: event.at, outcome: null, outcomeAt: null, review: null };
      return;
    case "run.outcome": {
      const run = state.runs[event.runId];
      if (!run)
        return;
      state.runs[event.runId] = { ...run, outcome: event.outcome, outcomeAt: event.at, review: run.review?.verdict === "changes" ? null : run.review };
      return;
    }
    case "run.reviewed": {
      const run = state.runs[event.runId];
      if (run)
        state.runs[event.runId] = { ...run, review: { verdict: event.verdict, at: event.at, note: event.note ?? "" } };
      return;
    }
    case "run.removed":
      delete state.runs[event.runId];
      return;
    case "run.pullRequest": {
      const run = state.runs[event.runId];
      if (run)
        state.runs[event.runId] = { ...run, pullRequest: { ...event.pullRequest, seenAt: event.at } };
      return;
    }
    case "calendar.added":
      if (!state.calendars[event.calendar.id])
        state.calendars[event.calendar.id] = { ...event.calendar, visible: true };
      return;
    case "calendar.updated": {
      const calendar = state.calendars[event.calendarId];
      if (calendar)
        state.calendars[event.calendarId] = { ...calendar, ...event.patch };
      return;
    }
    case "calendar.removed":
      delete state.calendars[event.calendarId];
      return;
    case "tasks.rolledOver":
      for (const rolled of event.moved) {
        const current = state.tasks[rolled.taskId];
        if (!current || current.placement.kind !== "day" || current.placement.date !== rolled.from)
          continue;
        touch(state, rolled.taskId, event.at, (task) => ({
          ...task,
          placement: { kind: "day", date: event.date },
          position: rolled.position,
          rolloverCount: task.rolloverCount + Math.max(1, daysBetween(rolled.from, event.date))
        }));
      }
      for (const taskId of event.archived) {
        touch(state, taskId, event.at, (task) => ({ ...task, archivedAt: event.at }));
      }
      for (const taskId of event.superseded ?? []) {
        touch(state, taskId, event.at, (task) => ({ ...task, deletedAt: event.at }));
      }
      return;
    case "tasks.recurred":
      for (const instance of event.instances)
        createTask(state, instance, event.at);
      return;
    case "series.created":
      if (state.series[event.series.id] || !state.tasks[event.taskId])
        return;
      state.series[event.series.id] = { ...event.series, stoppedFrom: null, createdAt: event.at };
      touch(state, event.taskId, event.at, (task) => ({ ...task, recurrence: { seriesId: event.series.id, date: event.series.startDate } }));
      return;
    case "series.updated": {
      const series = state.series[event.seriesId];
      if (!series)
        return;
      state.series[event.seriesId] = { ...series, ...event.patch.rule ? { rule: event.patch.rule } : {}, template: { ...series.template, ...event.patch.template } };
      return;
    }
    case "series.stopped": {
      const series = state.series[event.seriesId];
      if (series)
        state.series[event.seriesId] = { ...series, stoppedFrom: event.from };
      return;
    }
    case "channel.created": {
      if (state.channels[event.channel.id])
        return;
      state.channels[event.channel.id] = { ...event.channel, createdAt: event.at, deletedAt: null };
      return;
    }
    case "channel.updated": {
      const channel = state.channels[event.channelId];
      if (channel)
        state.channels[event.channelId] = { ...channel, ...event.patch };
      return;
    }
    case "channel.deleted": {
      const channel = state.channels[event.channelId];
      if (!channel)
        return;
      state.channels[event.channelId] = { ...channel, deletedAt: event.at };
      for (const task of Object.values(state.tasks)) {
        if (task.channelId === event.channelId)
          state.tasks[task.id] = { ...task, channelId: null, updatedAt: event.at };
      }
      return;
    }
    case "settings.updated":
      state.settings = { ...state.settings, ...event.patch };
      return;
    case "gtask.kept": {
      const key = googleTaskKey(event.account, event.taskId);
      const { starred, ...patch } = event.patch;
      const before = state.googleTasks[key] ?? { account: event.account, listId: event.listId, taskId: event.taskId, time: null, duration: null, deadline: null, repeat: null, starredAt: null, updatedAt: event.at };
      const starredAt = starred === undefined ? before.starredAt : starred ? before.starredAt ?? event.at : null;
      const next = { ...before, ...patch, listId: event.listId, starredAt, updatedAt: event.at };
      if (next.time === null && next.deadline === null && next.repeat === null && next.starredAt === null)
        delete state.googleTasks[key];
      else
        state.googleTasks[key] = next;
      return;
    }
    case "gtask.moved": {
      const key = googleTaskKey(event.account, event.taskId);
      const kept = state.googleTasks[key];
      if (!kept)
        return;
      const taskId = event.newTaskId ?? event.taskId;
      delete state.googleTasks[key];
      state.googleTasks[googleTaskKey(event.account, taskId)] = { ...kept, listId: event.listId, taskId, updatedAt: event.at };
      return;
    }
    case "gtask.dropped":
      delete state.googleTasks[googleTaskKey(event.account, event.taskId)];
      return;
  }
};
var applyEvents = (state, events) => {
  if (events.length === 0)
    return state;
  const next = {
    ...state,
    tasks: { ...state.tasks },
    channels: { ...state.channels },
    entries: { ...state.entries },
    blocks: { ...state.blocks },
    calendars: { ...state.calendars },
    objectives: { ...state.objectives },
    rituals: { ...state.rituals },
    series: { ...state.series },
    runs: { ...state.runs },
    folders: { ...state.folders },
    settings: { ...state.settings },
    googleTasks: { ...state.googleTasks }
  };
  for (const event of events)
    applyInto(next, event);
  return next;
};
var sortEvents = (events) => events.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
var foldEvents = (events) => applyEvents(emptyState(), events);

// service/store.ts
var MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/;
var README = `# Planner data

Written by the OpenChamber Planner extension. \`events/YYYY-MM.jsonl\` is an
append-only log of planner events, one JSON object per line; the planner's state
is a fold over all of them in (at, id) order. Lines from two replicas merge with
git's union driver, so a remote can be added later without conflicts.
`;
var isEventShape = (value) => {
  if (typeof value !== "object" || value === null)
    return false;
  const event = value;
  return event.v === 1 && typeof event.id === "string" && typeof event.at === "string" && typeof event.type === "string";
};

class EventStore {
  options;
  dir;
  eventsDir;
  commitDelayMs;
  log;
  gitEnabled = false;
  gitChain = Promise.resolve();
  commitTimer = null;
  pendingSummaries = [];
  commitsSincePackCheck = 0;
  lastCommitAt = null;
  lastError = null;
  skippedLines = 0;
  constructor(options) {
    this.options = options;
    this.dir = options.dir;
    this.eventsDir = join(options.dir, "events");
    this.commitDelayMs = options.commitDelayMs ?? 1500;
    this.log = options.log ?? (() => {});
  }
  get hasGit() {
    return this.gitEnabled;
  }
  async init() {
    mkdirSync(this.eventsDir, { recursive: true });
    if (this.options.git !== false)
      this.gitEnabled = await this.ensureRepo();
    if (this.gitEnabled)
      this.pack();
  }
  load() {
    const events = [];
    this.skippedLines = 0;
    for (const file of readdirSync(this.eventsDir).filter((name) => MONTH_FILE.test(name)).sort()) {
      for (const line of readFileSync(join(this.eventsDir, file), "utf8").split(`
`)) {
        if (!line.trim())
          continue;
        try {
          const parsed = JSON.parse(line);
          if (isEventShape(parsed))
            events.push(parsed);
          else
            this.skippedLines++;
        } catch {
          this.skippedLines++;
        }
      }
    }
    if (this.skippedLines)
      this.log(`skipped ${this.skippedLines} unreadable event lines`);
    return sortEvents(events);
  }
  append(events, summary) {
    const byFile = new Map;
    for (const event of events) {
      const file = `${event.at.slice(0, 7)}.jsonl`;
      byFile.set(file, (byFile.get(file) ?? "") + JSON.stringify(event) + `
`);
    }
    for (const [file, text] of byFile) {
      const fd = openSync(join(this.eventsDir, file), "a");
      try {
        writeSync(fd, text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    this.pendingSummaries.push(summary);
    this.scheduleCommit();
  }
  async flush() {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
      await this.commit();
    }
    await this.gitChain;
  }
  scheduleCommit() {
    if (!this.gitEnabled)
      return;
    if (this.commitTimer)
      clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      this.commit();
    }, this.commitDelayMs);
  }
  async commit() {
    const summaries = this.pendingSummaries.splice(0);
    if (!this.gitEnabled || summaries.length === 0)
      return;
    const message = summaries.length === 1 ? summaries[0] : `${summaries.length} planner changes

${summaries.map((line) => `- ${line}`).join(`
`)}`;
    try {
      await this.git(["add", "events"]);
      await this.git(["commit", "-q", "-m", message]);
      this.lastCommitAt = new Date().toISOString();
      this.lastError = null;
      this.options.onCommit?.();
      if (++this.commitsSincePackCheck >= (this.options.packCheckCommits ?? 20)) {
        this.commitsSincePackCheck = 0;
        this.pack();
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!/nothing to commit/.test(text)) {
        this.lastError = text.slice(0, 500);
        this.log(`git commit failed: ${this.lastError}`);
      }
    }
  }
  async remoteUrl() {
    if (!this.gitEnabled)
      return null;
    try {
      return (await this.git(["remote", "get-url", "origin"])).trim() || null;
    } catch {
      return null;
    }
  }
  async setRemote(url) {
    if (!this.gitEnabled)
      throw new Error("git is not available on this machine");
    const current = await this.remoteUrl();
    if (!url) {
      if (current)
        await this.git(["remote", "remove", "origin"]);
      return;
    }
    await this.git(current ? ["remote", "set-url", "origin", url] : ["remote", "add", "origin", url]);
  }
  async commitNow() {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
    await this.commit();
    await this.gitChain;
  }
  fetchRemote() {
    return this.git(["fetch", "--quiet", "origin"], 120000);
  }
  async mergeRemote() {
    const remote = (await this.git(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"]).catch(() => "")).trim();
    if (!remote)
      return false;
    const before = (await this.git(["rev-parse", "HEAD"])).trim();
    try {
      await this.git(["merge", "--quiet", "--no-edit", "--allow-unrelated-histories", "-m", "Merge planner data from origin", "refs/remotes/origin/main"]);
    } catch (error) {
      const conflicted = (await this.git(["diff", "--name-only", "--diff-filter=U"])).split(`
`).filter(Boolean);
      if (conflicted.length === 0 || conflicted.some((file) => file.startsWith("events/"))) {
        await this.git(["merge", "--abort"]).catch(() => {
          return;
        });
        throw error;
      }
      await this.git(["checkout", "--ours", "--", ...conflicted]);
      await this.git(["add", "--", ...conflicted]);
      await this.git(["commit", "--quiet", "--no-edit"]);
    }
    return (await this.git(["rev-parse", "HEAD"])).trim() !== before;
  }
  pushRemote() {
    return this.git(["push", "--quiet", "origin", "HEAD:refs/heads/main"], 120000);
  }
  git(args, timeout = 30000) {
    const run = () => new Promise((resolve, reject) => {
      execFile("git", ["-c", "user.name=OpenChamber Planner", "-c", "user.email=planner@localhost", "-c", "commit.gpgsign=false", ...args], { cwd: this.dir, timeout }, (error, stdout, stderr) => error ? reject(new Error(`${error.message}
${stderr}${stdout}`)) : resolve(stdout));
    });
    const next = this.gitChain.then(run, run);
    this.gitChain = next.catch(() => {
      return;
    });
    return next;
  }
  async pack() {
    try {
      const count = Number(/^count: (\d+)$/m.exec(await this.git(["count-objects", "-v"]))?.[1] ?? 0);
      if (count < (this.options.packLooseObjects ?? 256))
        return;
      await this.git(["repack", "-d", "-q"], 120000);
      await this.git(["-c", "gc.autoDetach=false", "gc", "--auto", "--quiet"], 120000);
    } catch (error) {
      this.log(`git pack failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
    }
  }
  async ensureRepo() {
    try {
      await this.git(["--version"]);
    } catch {
      this.log("git not found; events are stored without history");
      return false;
    }
    if (existsSync(join(this.dir, ".git")))
      return true;
    try {
      await this.git(["init", "-q", "-b", "main"]);
      writeFileSync(join(this.dir, ".gitattributes"), `events/*.jsonl merge=union
`);
      writeFileSync(join(this.dir, "README.md"), README);
      await this.git(["add", "-A"]);
      await this.git(["commit", "-q", "-m", "Initialize planner data"]);
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.log(`git init failed: ${this.lastError}`);
      return false;
    }
  }
}

// src/domain/rrule.ts
var WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
var FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
var KNOWN = new Set(["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "BYMONTH", "COUNT", "UNTIL"]);
var BYDAY = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/;
var UNTIL = /^\d{8}(T\d{6}Z?)?$/;
var parseRRule = (line) => {
  const body = line.trim().replace(/^RRULE:/i, "");
  if (!body)
    return null;
  const parts = new Map;
  const other = [];
  for (const part of body.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0)
      return null;
    const key = part.slice(0, eq).toUpperCase();
    const value = part.slice(eq + 1).toUpperCase();
    if (KNOWN.has(key))
      parts.set(key, value);
    else
      other.push([key, value]);
  }
  const freq = parts.get("FREQ") ?? "";
  if (!FREQUENCIES.includes(freq))
    return null;
  const interval = Number(parts.get("INTERVAL") ?? "1");
  if (!Number.isInteger(interval) || interval < 1 || interval > 999)
    return null;
  const byDay = (parts.get("BYDAY") ?? "").split(",").filter(Boolean);
  if (!byDay.every((code) => BYDAY.test(code)))
    return null;
  const numbers = (key, low, high) => {
    const values = (parts.get(key) ?? "").split(",").filter(Boolean).map(Number);
    return values.every((value) => Number.isInteger(value) && value !== 0 && value >= low && value <= high) ? values : null;
  };
  const byMonthDay = numbers("BYMONTHDAY", -31, 31);
  const byMonth = numbers("BYMONTH", 1, 12);
  if (!byMonthDay || !byMonth)
    return null;
  const count = parts.has("COUNT") ? Number(parts.get("COUNT")) : null;
  if (count !== null && (!Number.isInteger(count) || count < 1))
    return null;
  const until = parts.get("UNTIL") ?? null;
  if (until !== null && !UNTIL.test(until))
    return null;
  return { freq, interval, byDay, byMonthDay, byMonth, count, until, other };
};
var formatRRule = (rule) => {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval > 1)
    parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay.length)
    parts.push(`BYDAY=${rule.byDay.join(",")}`);
  if (rule.byMonthDay.length)
    parts.push(`BYMONTHDAY=${rule.byMonthDay.join(",")}`);
  if (rule.byMonth.length)
    parts.push(`BYMONTH=${rule.byMonth.join(",")}`);
  for (const [key, value] of rule.other)
    parts.push(`${key}=${value}`);
  if (rule.count !== null)
    parts.push(`COUNT=${rule.count}`);
  else if (rule.until !== null)
    parts.push(`UNTIL=${rule.until}`);
  return `RRULE:${parts.join(";")}`;
};
var splitRecurrence = (lines) => {
  const rules = lines.filter((line) => /^RRULE:/i.test(line.trim()));
  const rest = lines.filter((line) => !/^RRULE:/i.test(line.trim()));
  if (rules.length !== 1)
    return { rule: null, line: rules[0] ?? null, rest };
  return { rule: parseRRule(rules[0]), line: rules[0], rest };
};
var daysInMonth = (date) => {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
var weekdayOrdinal = (date) => {
  const day = Number(date.slice(8));
  return { nth: Math.ceil(day / 7), last: day + 7 > daysInMonth(date) };
};
var untilDate = (until, zone) => {
  const date = `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`;
  if (!isDateKey(date))
    return null;
  if (until.length === 8)
    return date;
  const instant = Date.parse(`${date}T${until.slice(9, 11)}:${until.slice(11, 13)}:${until.slice(13, 15)}Z`);
  return Number.isNaN(instant) ? null : zonedDateMinutes(instant, zone).date;
};
var utcStamp = (instant) => new Date(instant).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
var untilBefore = (occurrence) => {
  if (occurrence.date && isDateKey(occurrence.date))
    return addDays(occurrence.date, -1).replace(/-/g, "");
  const instant = Date.parse(occurrence.dateTime ?? "");
  return Number.isNaN(instant) ? null : utcStamp(instant - 1000);
};
var shiftCode = (code, days) => {
  const match = BYDAY.exec(code);
  if (!match || match[1])
    return null;
  const index = WEEKDAY_CODES.indexOf(match[2]);
  return WEEKDAY_CODES[((index + days) % 7 + 7) % 7];
};
var shiftRule = (rule, from, to) => {
  const days = daysBetween(from, to);
  if (days === 0)
    return rule;
  if (rule.other.some(([key]) => key !== "WKST"))
    return null;
  const code = WEEKDAY_CODES[weekday(to)];
  switch (rule.freq) {
    case "DAILY":
    case "WEEKLY": {
      if (rule.byMonthDay.length || rule.byMonth.length)
        return null;
      const byDay = rule.byDay.map((item) => shiftCode(item, days));
      return byDay.every(Boolean) ? { ...rule, byDay: [...new Set(byDay)] } : null;
    }
    case "MONTHLY": {
      if (rule.byMonth.length || rule.byDay.length && rule.byMonthDay.length)
        return null;
      if (rule.byMonthDay.length)
        return rule.byMonthDay.length === 1 ? { ...rule, byMonthDay: [Number(to.slice(8))] } : null;
      if (rule.byDay.length === 1 && BYDAY.exec(rule.byDay[0])?.[1]) {
        const { nth, last } = weekdayOrdinal(to);
        const wasLast = rule.byDay[0].startsWith("-1");
        return { ...rule, byDay: [`${wasLast && last ? -1 : nth >= 5 ? -1 : nth}${code}`] };
      }
      if (rule.byDay.length) {
        const byDay = rule.byDay.map((item) => shiftCode(item, days));
        return byDay.every(Boolean) ? { ...rule, byDay } : null;
      }
      return rule;
    }
    case "YEARLY":
      if (rule.byDay.length)
        return null;
      return {
        ...rule,
        byMonth: rule.byMonth.length ? [Number(to.slice(5, 7))] : [],
        byMonthDay: rule.byMonthDay.length ? [Number(to.slice(8))] : []
      };
  }
};

// src/domain/linearDisplay.ts
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var oneOf = (list, value) => typeof value === "string" && list.includes(value);
var linearDisplayProblem = (value) => {
  if (!isRecord(value))
    return "linearDisplay must be an object";
  if (!oneOf(LINEAR_GROUPS, value.subGroupBy))
    return `linearDisplay.subGroupBy must be one of ${LINEAR_GROUPS.join(", ")}`;
  if (!oneOf(LINEAR_COMPLETED, value.showCompleted))
    return `linearDisplay.showCompleted must be one of ${LINEAR_COMPLETED.join(", ")}`;
  for (const flag of ["orderReverse", "showSubIssues", "showEmptyGroups", "showEmptyColumns"])
    if (typeof value[flag] !== "boolean")
      return `linearDisplay.${flag} must be true or false`;
  if (!Array.isArray(value.properties) || value.properties.length > LINEAR_PROPERTIES.length || !value.properties.every((item) => oneOf(LINEAR_PROPERTIES, item)))
    return "linearDisplay.properties must list issue properties";
  const known = new Set(["subGroupBy", "orderReverse", "showCompleted", "showSubIssues", "showEmptyGroups", "showEmptyColumns", "properties"]);
  const extra = Object.keys(value).find((key) => !known.has(key));
  return extra ? `unknown linearDisplay.${extra}` : null;
};
var VIEW_PREF_FIELDS = `layout issueGrouping issueSubGrouping viewOrdering viewOrderingDirection showCompletedIssues showSubIssues showTriageIssues
      showEmptyGroups showEmptyGroupsBoard showEmptyGroupsList
      fieldId fieldStatus fieldPriority fieldAssignee fieldLabels fieldProject fieldCycle fieldEstimate fieldDueDate fieldDateCreated fieldDateUpdated
      projectLayout projectGrouping projectViewOrdering showCompletedProjects`;

// src/domain/assignees.ts
var COMMAND_PREFIX = "oc-planner-";
var COMMAND_MARKER = "# Written by the OpenChamber Planner";
var AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
var MODEL_REF = /^[^\s/#]{1,64}\/[^\s#]{1,160}(?:#[^\s#]{1,40})?$/;
var ASSIGNEE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
var isAgentName = (value) => typeof value === "string" && value.length <= 64 && AGENT_NAME.test(value);
var isModelRef = (value) => typeof value === "string" && MODEL_REF.test(value);
var isAssigneeId = (value) => typeof value === "string" && ASSIGNEE_ID.test(value);
var isPresetName = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 60 && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(value);
var isAgentPreset = (value) => {
  const preset = value;
  return typeof preset === "object" && preset !== null && isAssigneeId(preset.id) && isPresetName(preset.name) && isAgentName(preset.agent) && (preset.model === null || isModelRef(preset.model));
};
var isRunAssignee = (value) => {
  const assignee = value;
  return typeof assignee === "object" && assignee !== null && isAssigneeId(assignee.id) && isPresetName(assignee.name) && isAgentName(assignee.agent) && (assignee.model === null || isModelRef(assignee.model));
};
var commandName = (assignee) => `${COMMAND_PREFIX}${assignee.id}`;
var agentLabel = (name) => name === "build" ? "Build" : name === "plan" ? "Plan" : name.charAt(0).toUpperCase() + name.slice(1);
var presetAssignee = (preset) => ({ id: preset.id, name: preset.name, agent: preset.agent, model: preset.model });
var commandFile = (assignee, kind) => [
  "---",
  `${COMMAND_MARKER} (${kind}); it rewrites and removes this file.`,
  `description: ${JSON.stringify(`Planner: a task assigned to ${assignee.name}`)}`,
  `agent: ${JSON.stringify(assignee.agent)}`,
  ...assignee.model ? [`model: ${JSON.stringify(assignee.model)}`] : [],
  "---",
  "$ARGUMENTS",
  ""
].join(`
`);

// src/domain/events.ts
var PATCH_FIELDS = ["title", "notes", "plannedMinutes", "priority", "dueDate", "channelId", "folderId", "objectiveId", "subtasks", "source"];
var SERVICE_ONLY_TYPES = new Set(["tasks.rolledOver", "tasks.recurred"]);
var TITLE_MAX = 500;
var NOTES_MAX = 40000;
var isRecord2 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var isId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
var isMinutes = (value) => value === null || typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 24 * 60 * 7;
var isTitle = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= TITLE_MAX;
var BUCKET_IDS = new Set(BACKLOG_BUCKETS.map((bucket) => bucket.id));
var isPlacement = (value) => {
  if (!isRecord2(value))
    return false;
  if (value.kind === "day")
    return isDateKey(value.date);
  if (value.kind === "backlog")
    return typeof value.bucket === "string" && BUCKET_IDS.has(value.bucket);
  return false;
};
var isSubtasks = (value) => Array.isArray(value) && value.length <= 200 && value.every((item) => isRecord2(item) && isId(item.id) && isTitle(item.title) && typeof item.done === "boolean");
var isShortText = (value, max) => typeof value === "string" && value.length <= max;
var isSource = (value) => isRecord2(value) && typeof value.kind === "string" && Object.hasOwn(SOURCE_NAMES, value.kind) && isShortText(value.id, 200) && value.id.length > 0 && isShortText(value.key, 100) && isShortText(value.url, 2000) && /^https:\/\//.test(value.url) && (value.title === undefined || isShortText(value.title, TITLE_MAX)) && (value.teamId === undefined || isShortText(value.teamId, 200)) && (value.status === undefined || isRecord2(value.status) && isShortText(value.status.name, 100) && isShortText(value.status.type, 40) && isShortText(value.status.color, 40)) && (value.mirrors === undefined || Array.isArray(value.mirrors) && value.mirrors.length <= 10 && value.mirrors.every((key) => isShortText(key, 200))) && (value.workspaceId === undefined || isShortText(value.workspaceId, 200) && value.workspaceId.length > 0) && (value.branch === undefined || isShortText(value.branch, 200)) && (value.account === undefined || typeof value.account === "string" && /^[^\s@]{1,100}@[^\s@]{1,100}$/.test(value.account)) && (value.listId === undefined || isShortText(value.listId, 200) && value.listId.length > 0) && (value.notes === undefined || isShortText(value.notes, GOOGLE_NOTES_MAX)) && (value.due === undefined || value.due === null || isDateKey(value.due));
var GOOGLE_NOTES_MAX = 8192;
var isGoogleTaskId = (value) => typeof value === "string" && value.length > 0 && value.length <= 1024;
var GTASK_TEMPLATE_FIELDS = ["title", "notes", "time", "duration", "deadline", "start"];
var validateGtaskTemplate = (value) => {
  if (!isRecord2(value))
    return "repeat template must be an object";
  if (typeof value.title !== "string" || value.title.length > 1024)
    return "template title must be text, at most 1024 characters";
  if (typeof value.notes !== "string" || value.notes.length > GOOGLE_NOTES_MAX)
    return `template notes must be text, at most ${GOOGLE_NOTES_MAX} characters`;
  if (!(value.time === null || Number.isInteger(value.time) && value.time >= 0 && value.time < 24 * 60))
    return "template time must be minutes after midnight, or null";
  if (!(value.duration === null || Number.isInteger(value.duration) && value.duration >= 5 && value.duration <= 24 * 60))
    return "template duration must be 5 to 1440 minutes, or null";
  if (!(value.deadline === null || Number.isInteger(value.deadline) && Math.abs(value.deadline) <= 3660))
    return "template deadline must be days from the date, or null";
  if (!isDateKey(value.start))
    return "template start must be a date";
  return Object.keys(value).some((field) => !GTASK_TEMPLATE_FIELDS.includes(field)) ? "template has an unknown field" : null;
};
var GTASK_EXCEPTION_FIELDS = ["skip", "title", "notes", "date", "time", "duration", "deadline"];
var GTASK_EXCEPTIONS_MAX = 200;
var validateGtaskException = (value) => {
  if (!isRecord2(value))
    return "an occurrence change must be an object";
  const fields = Object.keys(value);
  if (!fields.length)
    return "an occurrence change needs a field";
  if (fields.some((field) => !GTASK_EXCEPTION_FIELDS.includes(field)))
    return "an occurrence change has an unknown field";
  if (value.skip !== undefined && (value.skip !== true || fields.length > 1))
    return "a skipped occurrence is skip: true alone";
  if (value.title !== undefined && !(typeof value.title === "string" && value.title.trim().length > 0 && value.title.length <= 1024))
    return "an occurrence title must be 1-1024 characters";
  if (value.notes !== undefined && !(typeof value.notes === "string" && value.notes.length <= GOOGLE_NOTES_MAX))
    return `an occurrence's notes must be text, at most ${GOOGLE_NOTES_MAX} characters`;
  if (value.date !== undefined && !isDateKey(value.date))
    return "an occurrence date must be a date";
  if (value.time !== undefined && !(value.time === null || Number.isInteger(value.time) && value.time >= 0 && value.time < 24 * 60))
    return "an occurrence time must be minutes after midnight, or null";
  if (value.duration !== undefined && !(value.duration === null || Number.isInteger(value.duration) && value.duration >= 5 && value.duration <= 24 * 60))
    return "an occurrence duration must be 5 to 1440 minutes, or null";
  if (value.deadline !== undefined && !(value.deadline === null || isDateKey(value.deadline)))
    return "an occurrence deadline must be a date or null";
  return null;
};
var validateKeptPatch = (patch) => {
  if (!isRecord2(patch))
    return "patch must be an object";
  for (const [key, value] of Object.entries(patch)) {
    if (key === "time" && !(value === null || Number.isInteger(value) && value >= 0 && value < 24 * 60))
      return "time must be minutes after midnight, or null";
    else if (key === "duration" && !(value === null || Number.isInteger(value) && value >= 5 && value <= 24 * 60))
      return "duration must be 5 to 1440 minutes, or null";
    else if (key === "deadline" && !(value === null || isDateKey(value)))
      return "deadline must be a date or null";
    else if (key === "starred" && typeof value !== "boolean")
      return "starred must be true or false";
    else if (key === "repeat") {
      if (value === null)
        continue;
      if (!isRecord2(value) || typeof value.rule !== "string" || value.rule.length > 500 || !parseRRule(value.rule))
        return "repeat needs an RRULE";
      if (!isId(value.seriesId))
        return "repeat needs a series id";
      if (!(Number.isInteger(value.index) && value.index >= 1 && value.index <= 1e5))
        return "repeat index must be a count";
      if (!(value.next === null || isGoogleTaskId(value.next)))
        return "repeat next must be a task id or null";
      if (value.on !== undefined && !isDateKey(value.on))
        return "repeat on must be a date";
      if (value.template !== undefined) {
        const error = validateGtaskTemplate(value.template);
        if (error)
          return error;
      }
      if (value.exceptions !== undefined) {
        if (!isRecord2(value.exceptions) || Object.keys(value.exceptions).length > GTASK_EXCEPTIONS_MAX)
          return `repeat exceptions must be at most ${GTASK_EXCEPTIONS_MAX} occurrences by date`;
        for (const [date, change] of Object.entries(value.exceptions)) {
          if (!isDateKey(date))
            return "repeat exceptions are by date";
          const error = validateGtaskException(change);
          if (error)
            return error;
        }
      }
      if (Object.keys(value).some((field) => !["rule", "seriesId", "index", "next", "on", "template", "exceptions"].includes(field)))
        return "repeat has an unknown field";
    } else if (!["time", "duration", "deadline", "starred", "repeat"].includes(key))
      return `unknown field ${key}`;
  }
  return null;
};
var PRIORITY_VALUES = new Set(["urgent", "high", "medium", "low"]);
var isPriority = (value) => value === null || typeof value === "string" && PRIORITY_VALUES.has(value);
var isColor = (value) => typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
var isChannelName = (value) => typeof value === "string" && /^[\p{L}\p{N}_-]{1,40}$/u.test(value);
var validatePatch = (patch, channels, objectives, folders) => {
  if (!isRecord2(patch))
    return "patch must be an object";
  for (const [key, value] of Object.entries(patch)) {
    if (key === "title" && !isTitle(value))
      return "title must be 1-500 characters";
    else if (key === "notes" && !(typeof value === "string" && value.length <= NOTES_MAX))
      return "notes are too long";
    else if (key === "plannedMinutes" && !isMinutes(value))
      return "plannedMinutes must be a number of minutes or null";
    else if (key === "priority" && !isPriority(value))
      return "priority is invalid";
    else if (key === "dueDate" && !(value === null || isDateKey(value)))
      return "dueDate must be a date or null";
    else if (key === "channelId" && !(value === null || isId(value) && channels[value]))
      return "unknown channel";
    else if (key === "objectiveId" && !(value === null || isId(value) && objectives[value]))
      return "unknown objective";
    else if (key === "folderId" && !(value === null || isId(value) && folders[value] && !folders[value].deletedAt))
      return "unknown folder";
    else if (key === "subtasks" && !isSubtasks(value))
      return "subtasks are invalid";
    else if (key === "source" && !(value === null || isSource(value)))
      return "source is invalid";
    else if (!PATCH_FIELDS.includes(key))
      return `unknown field ${key}`;
  }
  return null;
};
var validateChannelPatch = (patch) => {
  if (!isRecord2(patch))
    return "patch must be an object";
  for (const [key, value] of Object.entries(patch)) {
    if (key === "name" && !isChannelName(value))
      return "channel name must be 1-40 letters, digits, _ or -";
    else if (key === "color" && !isColor(value))
      return "color must be #rrggbb";
    else if (key === "context" && value !== "work" && value !== "personal")
      return "context must be work or personal";
    else if (!["name", "color", "context"].includes(key))
      return `unknown field ${key}`;
  }
  return null;
};
var isGoogleAccount = (value) => typeof value === "string" && /^[^\s@]{1,100}@[^\s@]{1,100}$/.test(value);
var isGoogleCalendarRef = (value) => isRecord2(value) && isGoogleAccount(value.account) && isShortText(value.calendarId, 1024) && value.calendarId.length > 0;
var isGoogleEventLink = (value) => isGoogleCalendarRef(value) && isShortText(value.eventId, 1024) && value.eventId.length > 0;
var validateSettingsPatch = (patch) => {
  if (!isRecord2(patch))
    return "patch must be an object";
  for (const [key, value] of Object.entries(patch)) {
    if (key === "timezone" && !isValidTimeZone(value))
      return "timezone must be an IANA zone";
    else if (key === "workloadMinutes" && !(typeof value === "number" && value > 0 && value <= 24 * 60))
      return "workloadMinutes must be 1-1440";
    else if (key === "archiveAfterRollovers" && !(value === null || Number.isInteger(value) && value >= 1 && value <= 365))
      return "archiveAfterRollovers must be 1-365 or null";
    else if (key === "weekStartsOn" && value !== 0 && value !== 1)
      return "weekStartsOn must be 0 or 1";
    else if (key === "plannedAsActual" && typeof value !== "boolean")
      return "plannedAsActual must be true or false";
    else if ((key === "workdayStart" || key === "workdayEnd") && !(Number.isInteger(value) && value >= 0 && value <= 24 * 60))
      return `${key} must be minutes after midnight`;
    else if (key === "linearOnComplete" && !["ask", "complete", "nothing"].includes(value))
      return "linearOnComplete must be ask, complete or nothing";
    else if (key === "linearOnPlan" && !["ask", "start", "nothing"].includes(value))
      return "linearOnPlan must be ask, start or nothing";
    else if (key === "linearImportCompletion" && typeof value !== "boolean")
      return "linearImportCompletion must be true or false";
    else if (key === "linearLayout" && value !== "list" && value !== "board")
      return "linearLayout must be list or board";
    else if (key === "linearGroupBy" && !LINEAR_GROUPS.includes(value))
      return `linearGroupBy must be one of ${LINEAR_GROUPS.join(", ")}`;
    else if (key === "linearOrderBy" && !LINEAR_ORDERS.includes(value))
      return `linearOrderBy must be one of ${LINEAR_ORDERS.join(", ")}`;
    else if (key === "linearDisplay") {
      const problem = linearDisplayProblem(value);
      if (problem)
        return problem;
    } else if (key === "suggestFromHistory" && typeof value !== "boolean")
      return "suggestFromHistory must be true or false";
    else if ((key === "pomodoroMinutes" || key === "breakMinutes") && !(Number.isInteger(value) && value >= 1 && value <= 180))
      return `${key} must be 1-180`;
    else if (key === "googleTimebox" && !(value === null || isGoogleCalendarRef(value)))
      return "googleTimebox must be a Google account and calendar, or null";
    else if (key === "googleTasksOnComplete" && !["ask", "complete", "nothing"].includes(value))
      return "googleTasksOnComplete must be ask, complete or nothing";
    else if ((key === "googleTasksImportCompletion" || key === "googleTasksDueFromPlan" || key === "googleTasksOnCalendar") && typeof value !== "boolean")
      return `${key} must be true or false`;
    else if (key === "googleCalendarsIntroduced" && !(Array.isArray(value) && value.length <= 50 && value.every((email) => typeof email === "string" && email.length <= 254 && email.includes("@"))))
      return "googleCalendarsIntroduced must be at most 50 email addresses";
    else if (key === "agentPresets" && !(Array.isArray(value) && value.length <= 30 && value.every(isAgentPreset) && new Set(value.map((preset) => preset.id)).size === value.length))
      return "agentPresets must be at most 30 presets with distinct ids, each a name, an agent and a model or null";
    else if (key === "agentPresets")
      continue;
    else if (!["timezone", "workloadMinutes", "archiveAfterRollovers", "weekStartsOn", "plannedAsActual", "workdayStart", "workdayEnd", "linearOnComplete", "linearOnPlan", "linearImportCompletion", "linearLayout", "linearGroupBy", "linearOrderBy", "suggestFromHistory", "pomodoroMinutes", "breakMinutes", "googleTimebox", "googleTasksOnComplete", "googleTasksImportCompletion", "googleTasksDueFromPlan", "googleTasksOnCalendar", "googleCalendarsIntroduced"].includes(key))
      return `unknown setting ${key}`;
  }
  return null;
};
var isFolderName = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 60;
var isSessionRef = (value) => value === null || isRecord2(value) && isShortText(value.sessionId, 200) && value.sessionId.length > 0 && isShortText(value.title, 500) && (value.directory === null || isShortText(value.directory, 1024));
var isRunShape = (value) => {
  if (!isRecord2(value) || !isId(value.id))
    return "run needs an id";
  if (!(isShortText(value.sessionId, 200) && value.sessionId.length > 0))
    return "run needs a session";
  if (!(value.projectId === null || isShortText(value.projectId, 1024)))
    return "projectId is invalid";
  if (!(value.directory === null || isShortText(value.directory, 1024)))
    return "directory is invalid";
  if (!(value.worktree === null || isRecord2(value.worktree) && isShortText(value.worktree.directory, 1024) && (value.worktree.branch === null || isShortText(value.worktree.branch, 200))))
    return "worktree is invalid";
  if (value.wantsPr !== undefined && typeof value.wantsPr !== "boolean")
    return "wantsPr must be true or false";
  if (!(value.assignee === undefined || value.assignee === null || isRunAssignee(value.assignee)))
    return "assignee is invalid";
  return isShortText(value.title, TITLE_MAX) ? null : "title is invalid";
};
var PULL_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/pull\/\d{1,9}$/;
var isPullRequest = (value) => isRecord2(value) && Number.isInteger(value.number) && value.number > 0 && typeof value.url === "string" && PULL_URL.test(value.url) && ["open", "closed", "merged"].includes(value.state) && typeof value.draft === "boolean" && isShortText(value.title, TITLE_MAX) && typeof value.repo === "string" && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value.repo);
var isRule = (value) => {
  if (!isRecord2(value))
    return false;
  if (!["daily", "weekly", "monthly", "yearly"].includes(value.freq))
    return false;
  if (!(Number.isInteger(value.interval) && value.interval >= 1 && value.interval <= 365))
    return false;
  if (value.weekdays !== undefined && !(Array.isArray(value.weekdays) && value.weekdays.length <= 7 && value.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)))
    return false;
  if (value.monthDay !== undefined && !(Number.isInteger(value.monthDay) && value.monthDay !== 0 && Math.abs(value.monthDay) <= 31))
    return false;
  return true;
};
var validateTemplate = (template, channels, partial) => {
  if (!isRecord2(template))
    return "template must be an object";
  const has = (key) => (key in template);
  if ((has("title") || !partial) && !isTitle(template.title))
    return "title must be 1-500 characters";
  if ((has("notes") || !partial) && !(typeof template.notes === "string" && template.notes.length <= NOTES_MAX))
    return "notes are too long";
  if ((has("plannedMinutes") || !partial) && !isMinutes(template.plannedMinutes))
    return "plannedMinutes is invalid";
  if ((has("priority") || !partial) && !isPriority(template.priority))
    return "priority is invalid";
  if ((has("channelId") || !partial) && !(template.channelId === null || isId(template.channelId) && channels[template.channelId]))
    return "unknown channel";
  if ((has("subtasks") || !partial) && !(Array.isArray(template.subtasks) && template.subtasks.length <= 200 && template.subtasks.every(isTitle)))
    return "subtasks are invalid";
  return null;
};
var TEXT_MAX = 20000;
var RITUAL_FIELDS = {
  planning: ["completedAt", "obstacles", "shutdownTime"],
  shutdown: ["completedAt", "reflection"],
  highlights: ["completedAt", "items", "summary", "reflection", "publishedAt"],
  weeklyPlanning: ["completedAt", "journal"],
  weeklyReview: ["completedAt", "journal"]
};
var validateRitualFields = (ritual, fields) => {
  if (!isRecord2(fields))
    return "fields must be an object";
  for (const [key, value] of Object.entries(fields)) {
    if (!RITUAL_FIELDS[ritual].includes(key))
      return `${ritual} has no field ${key}`;
    if ((key === "completedAt" || key === "publishedAt") && !(value === null || isInstantString(value)))
      return `${key} must be an ISO instant or null`;
    if ((key === "obstacles" || key === "reflection" || key === "summary" || key === "journal") && !(typeof value === "string" && value.length <= TEXT_MAX))
      return `${key} is too long`;
    if (key === "shutdownTime" && !(value === null || Number.isInteger(value) && value >= 0 && value <= 24 * 60))
      return "shutdownTime must be minutes after midnight";
    if (key === "items") {
      if (!Array.isArray(value) || value.length > 100)
        return "items must be a list of at most 100";
      for (const item of value) {
        if (!isRecord2(item) || !isId(item.id) || !(typeof item.text === "string" && item.text.trim() && item.text.length <= 1000) || typeof item.starred !== "boolean" || !(item.taskId === null || isId(item.taskId)) || !(item.hidden === undefined || typeof item.hidden === "boolean"))
          return "a highlight is invalid";
      }
    }
  }
  return null;
};
var isInstantString = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
var isFeedUrl = (value) => typeof value === "string" && value.length <= 2000 && /^(https?|webcal|file):\/\/\S+$/i.test(value);
var isInstant = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value);
var MAX_ENTRY_MS = 24 * 60 * 60 * 1000;
var validateSpan = (start, end) => {
  if (!isInstant(start) || !isInstant(end))
    return "start and end must be ISO instants";
  const span = Date.parse(end) - Date.parse(start);
  return span >= 5 * 60000 && span <= MAX_ENTRY_MS ? null : "a working session lasts between 5 minutes and 24 hours";
};
var validateCommand = (command, context) => {
  if (!isRecord2(command))
    return "command must be an object";
  if (!isId(command.cmd))
    return "command needs a cmd id";
  const { tasks, channels } = context;
  const type = command.type;
  if (SERVICE_ONLY_TYPES.has(type))
    return `${type} is written by the service only`;
  const needTask = () => isId(command.taskId) && tasks[command.taskId] ? null : "unknown task";
  const needChannel = () => isId(command.channelId) && channels[command.channelId] ? null : "unknown channel";
  switch (type) {
    case "task.created": {
      const task = command.task;
      if (!isRecord2(task) || !isId(task.id))
        return "task needs an id";
      if (tasks[task.id])
        return "task id already exists";
      if (!isTitle(task.title))
        return "title must be 1-500 characters";
      if (!isPlacement(task.placement))
        return "placement is invalid";
      if (typeof task.position !== "number" || !Number.isFinite(task.position))
        return "position must be a number";
      if (task.notes !== undefined && !(typeof task.notes === "string" && task.notes.length <= NOTES_MAX))
        return "notes are too long";
      if (task.plannedMinutes !== undefined && !isMinutes(task.plannedMinutes))
        return "plannedMinutes is invalid";
      if (task.priority !== undefined && !isPriority(task.priority))
        return "priority is invalid";
      if (task.dueDate !== undefined && !(task.dueDate === null || isDateKey(task.dueDate)))
        return "dueDate must be a date or null";
      if (task.channelId !== undefined && !(task.channelId === null || isId(task.channelId) && channels[task.channelId]))
        return "unknown channel";
      if (task.source !== undefined && !(task.source === null || isSource(task.source)))
        return "source is invalid";
      if (task.objectiveId !== undefined && !(task.objectiveId === null || isId(task.objectiveId) && context.objectives[task.objectiveId]))
        return "unknown objective";
      if (task.subtasks !== undefined && !isSubtasks(task.subtasks))
        return "subtasks are invalid";
      if (task.folderId !== undefined && !(task.folderId === null || isId(task.folderId) && context.folders[task.folderId] && !context.folders[task.folderId].deletedAt))
        return "unknown folder";
      if (task.recurrence !== undefined && task.recurrence !== null)
        return "recurrence is set through a series";
      if (task.sessionRef !== undefined && !isSessionRef(task.sessionRef))
        return "sessionRef is invalid";
      return null;
    }
    case "task.updated":
      return needTask() ?? validatePatch(command.patch, channels, context.objectives, context.folders);
    case "task.moved":
      if (!isPlacement(command.placement))
        return "placement is invalid";
      if (typeof command.position !== "number" || !Number.isFinite(command.position))
        return "position must be a number";
      return needTask();
    case "task.completed":
      return needTask() ?? (isDateKey(command.on) ? null : "on must be a date");
    case "task.reopened":
    case "task.deleted":
    case "task.restored":
    case "task.archived":
      return needTask();
    case "task.sourceSynced":
      if (!isSource(command.source))
        return "source is invalid";
      if (command.title !== undefined && !isTitle(command.title))
        return "title must be 1-500 characters";
      if (command.notes !== undefined && !(typeof command.notes === "string" && command.notes.length <= NOTES_MAX))
        return "notes are too long";
      if (command.dueDate !== undefined && !(command.dueDate === null || isDateKey(command.dueDate)))
        return "dueDate must be a date or null";
      return needTask();
    case "timer.started":
      return needTask();
    case "timer.stopped":
      return null;
    case "time.logged": {
      const entry = command.entry;
      if (!isRecord2(entry) || !isId(entry.id))
        return "entry needs an id";
      if (context.entries[entry.id])
        return "entry id already exists";
      if (!(isId(entry.taskId) && tasks[entry.taskId]))
        return "unknown task";
      if (!isInstant(entry.start) || !isInstant(entry.end))
        return "start and end must be ISO instants";
      const span = Date.parse(entry.end) - Date.parse(entry.start);
      return span > 0 && span <= MAX_ENTRY_MS ? null : "an entry must last between 0 and 24 hours";
    }
    case "time.deleted":
      return isId(command.entryId) && context.entries[command.entryId] ? null : "unknown entry";
    case "block.created": {
      const block = command.block;
      if (!isRecord2(block) || !isId(block.id))
        return "block needs an id";
      if (context.blocks[block.id])
        return "block id already exists";
      if (!(isId(block.taskId) && tasks[block.taskId]))
        return "unknown task";
      return validateSpan(block.start, block.end);
    }
    case "block.updated":
      if (!(isId(command.blockId) && context.blocks[command.blockId]))
        return "unknown block";
      return validateSpan(command.start, command.end);
    case "block.deleted":
      return isId(command.blockId) && context.blocks[command.blockId] ? null : "unknown block";
    case "block.linked":
      if (!(isId(command.blockId) && context.blocks[command.blockId]))
        return "unknown block";
      return command.google === null || isGoogleEventLink(command.google) ? null : "google must be an account, calendar and event, or null";
    case "calendar.added": {
      const calendar = command.calendar;
      if (!isRecord2(calendar) || !isId(calendar.id))
        return "calendar needs an id";
      if (context.calendars[calendar.id])
        return "calendar id already exists";
      if (!(typeof calendar.name === "string" && calendar.name.trim() && calendar.name.length <= 80))
        return "calendar name must be 1-80 characters";
      if (!isFeedUrl(calendar.url))
        return "calendar URL must be http(s), webcal or file";
      if (calendar.google !== undefined && !isGoogleCalendarRef(calendar.google))
        return "google must be an account and a calendar";
      return isColor(calendar.color) ? null : "color must be #rrggbb";
    }
    case "calendar.updated": {
      if (!(isId(command.calendarId) && context.calendars[command.calendarId]))
        return "unknown calendar";
      const patch = command.patch;
      if (!isRecord2(patch))
        return "patch must be an object";
      for (const [key, value] of Object.entries(patch)) {
        if (key === "name" && !(typeof value === "string" && value.trim() && value.length <= 80))
          return "calendar name must be 1-80 characters";
        else if (key === "color" && !isColor(value))
          return "color must be #rrggbb";
        else if (key === "visible" && typeof value !== "boolean")
          return "visible must be true or false";
        else if (!["name", "color", "visible"].includes(key))
          return `unknown field ${key}`;
      }
      return null;
    }
    case "calendar.removed":
      return isId(command.calendarId) && context.calendars[command.calendarId] ? null : "unknown calendar";
    case "objective.created": {
      const objective = command.objective;
      if (!isRecord2(objective) || !isId(objective.id))
        return "objective needs an id";
      if (context.objectives[objective.id])
        return "objective id already exists";
      if (!isDateKey(objective.weekStart))
        return "weekStart must be a date";
      if (!(typeof objective.title === "string" && objective.title.trim() && objective.title.length <= 200))
        return "objective title must be 1-200 characters";
      return objective.carriedFrom === null || objective.carriedFrom === undefined || isId(objective.carriedFrom) && context.objectives[objective.carriedFrom] ? null : "unknown objective to continue";
    }
    case "objective.updated": {
      if (!(isId(command.objectiveId) && context.objectives[command.objectiveId]))
        return "unknown objective";
      const patch = command.patch;
      if (!isRecord2(patch))
        return "patch must be an object";
      for (const [key, value] of Object.entries(patch)) {
        if (key === "title" && !(typeof value === "string" && value.trim() && value.length <= 200))
          return "objective title must be 1-200 characters";
        else if (key === "completed" && typeof value !== "boolean")
          return "completed must be true or false";
        else if (key !== "title" && key !== "completed")
          return `unknown field ${key}`;
      }
      return null;
    }
    case "objective.deleted":
      return isId(command.objectiveId) && context.objectives[command.objectiveId] ? null : "unknown objective";
    case "series.created": {
      const series = command.series;
      if (!isRecord2(series) || !isId(series.id))
        return "series needs an id";
      if (context.series[series.id])
        return "series id already exists";
      if (!isRule(series.rule))
        return "rule is invalid";
      if (!isDateKey(series.startDate))
        return "startDate must be a date";
      if (!(isId(command.taskId) && tasks[command.taskId]))
        return "unknown task";
      if (tasks[command.taskId].recurrence)
        return "task already repeats";
      return validateTemplate(series.template, channels, false);
    }
    case "series.updated": {
      if (!(isId(command.seriesId) && context.series[command.seriesId]))
        return "unknown series";
      const patch = command.patch;
      if (!isRecord2(patch))
        return "patch must be an object";
      if (patch.rule !== undefined && !isRule(patch.rule))
        return "rule is invalid";
      if (patch.template !== undefined)
        return validateTemplate(patch.template, channels, true);
      return Object.keys(patch).every((key) => key === "rule" || key === "template") ? null : "unknown field";
    }
    case "series.stopped":
      if (!(isId(command.seriesId) && context.series[command.seriesId]))
        return "unknown series";
      return isDateKey(command.from) ? null : "from must be a date";
    case "folder.created": {
      const folder = command.folder;
      if (!isRecord2(folder) || !isId(folder.id))
        return "folder needs an id";
      if (context.folders[folder.id])
        return "folder id already exists";
      return isFolderName(folder.name) ? null : "folder name must be 1-60 characters";
    }
    case "folder.renamed":
      if (!(isId(command.folderId) && context.folders[command.folderId]))
        return "unknown folder";
      return isFolderName(command.name) ? null : "folder name must be 1-60 characters";
    case "folder.deleted":
      return isId(command.folderId) && context.folders[command.folderId] ? null : "unknown folder";
    case "run.started": {
      const run = command.run;
      const error = isRunShape(run);
      if (error)
        return error;
      if (context.runs[run.id])
        return "run id already exists";
      const taskId = run.taskId;
      return isId(taskId) && tasks[taskId] ? null : "unknown task";
    }
    case "run.outcome":
      if (!(isId(command.runId) && context.runs[command.runId]))
        return "unknown run";
      return command.outcome === "completed" || command.outcome === "failed" ? null : "outcome must be completed or failed";
    case "run.reviewed":
      if (!(isId(command.runId) && context.runs[command.runId]))
        return "unknown run";
      if (command.verdict !== "accepted" && command.verdict !== "changes")
        return "verdict must be accepted or changes";
      return command.note === undefined || isShortText(command.note, 4000) ? null : "note is too long";
    case "run.removed":
      return isId(command.runId) && context.runs[command.runId] ? null : "unknown run";
    case "run.pullRequest": {
      const run = isId(command.runId) ? context.runs[command.runId] : undefined;
      if (!run)
        return "unknown run";
      if (command.taskId !== run.taskId)
        return "taskId must be the run's task";
      return isPullRequest(command.pullRequest) ? null : "pullRequest is invalid";
    }
    case "ritual.saved":
      if (!RITUALS.includes(command.ritual))
        return "unknown ritual";
      if (!isDateKey(command.date))
        return "date must be a date";
      return validateRitualFields(command.ritual, command.fields);
    case "channel.created": {
      const channel = command.channel;
      if (!isRecord2(channel) || !isId(channel.id))
        return "channel needs an id";
      if (channels[channel.id])
        return "channel id already exists";
      const error = validateChannelPatch({ name: channel.name, color: channel.color, context: channel.context });
      if (error)
        return error;
      const name = channel.name.toLowerCase();
      return Object.values(channels).some((other) => !other.deletedAt && other.name.toLowerCase() === name) ? "a channel with that name exists" : null;
    }
    case "channel.updated":
      return needChannel() ?? validateChannelPatch(command.patch);
    case "channel.deleted":
      return needChannel();
    case "settings.updated":
      return validateSettingsPatch(command.patch);
    case "gtask.kept":
      if (!isGoogleAccount(command.account) || !isGoogleTaskId(command.listId) || !isGoogleTaskId(command.taskId))
        return "a Google account, list and task are required";
      return validateKeptPatch(command.patch);
    case "gtask.moved":
      if (!isGoogleAccount(command.account) || !isGoogleTaskId(command.taskId) || !isGoogleTaskId(command.listId))
        return "a Google account, task and list are required";
      return command.newTaskId === undefined || isGoogleTaskId(command.newTaskId) ? null : "newTaskId must be a task id";
    case "gtask.dropped":
      return isGoogleAccount(command.account) && isGoogleTaskId(command.taskId) ? null : "a Google account and task are required";
    default:
      return `unknown command type ${String(type)}`;
  }
};
var commandBody = (command) => {
  const { cmd: _cmd, ...body } = command;
  return body;
};

// src/domain/recurrence.ts
var RECURRENCE_HORIZON_DAYS = 7;
var parts = (date) => date.split("-").map(Number);
var daysInMonth2 = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
var occursOn = (rule, startDate, date) => {
  if (date < startDate)
    return false;
  const interval = Math.max(1, rule.interval || 1);
  switch (rule.freq) {
    case "daily":
      return daysBetween(startDate, date) % interval === 0 && (!rule.weekdays?.length || rule.weekdays.includes(weekday(date)));
    case "weekly": {
      const days = rule.weekdays?.length ? rule.weekdays : [weekday(startDate)];
      const weeks = Math.round(daysBetween(startOfWeek(startDate, 1), startOfWeek(date, 1)) / 7);
      return weeks % interval === 0 && days.includes(weekday(date));
    }
    case "monthly": {
      const [sy, sm, sd] = parts(startDate);
      const [y, m, d] = parts(date);
      if (((y - sy) * 12 + (m - sm)) % interval !== 0)
        return false;
      const total = daysInMonth2(y, m);
      const wanted = rule.monthDay ?? sd;
      const target = wanted < 0 ? total + wanted + 1 : Math.min(wanted, total);
      return d === target;
    }
    case "yearly": {
      const [sy, sm, sd] = parts(startDate);
      const [y, m, d] = parts(date);
      return (y - sy) % interval === 0 && m === sm && d === Math.min(sd, daysInMonth2(y, m));
    }
  }
};
var instanceId = (seriesId, date) => `r-${seriesId}-${date.replaceAll("-", "")}`.slice(0, 64);
var planInstances = (state, today, horizon = RECURRENCE_HORIZON_DAYS) => {
  const existing = new Set(Object.values(state.tasks).filter((task) => task.recurrence).map((task) => `${task.recurrence.seriesId}|${task.recurrence.date}`));
  const out = [];
  const offsets = new Map;
  for (const series of Object.values(state.series)) {
    const first = series.startDate > today ? series.startDate : today;
    for (let date = first;date <= addDays(today, horizon); date = addDays(date, 1)) {
      if (series.stoppedFrom && date >= series.stoppedFrom)
        break;
      if (!occursOn(series.rule, series.startDate, date) || existing.has(`${series.id}|${date}`))
        continue;
      const offset = (offsets.get(date) ?? 0) + 1;
      offsets.set(date, offset);
      out.push(instanceFrom(series, date, edgePosition(state, { kind: "day", date }, "bottom") + (offset - 1) * 1024));
    }
  }
  return out;
};
var instanceFrom = (series, date, position) => ({
  id: instanceId(series.id, date),
  title: series.template.title,
  notes: series.template.notes,
  plannedMinutes: series.template.plannedMinutes,
  priority: series.template.priority,
  channelId: series.template.channelId,
  placement: { kind: "day", date },
  position,
  subtasks: series.template.subtasks.map((title, index) => ({ id: `${instanceId(series.id, date)}-s${index}`, title, done: false })),
  recurrence: { seriesId: series.id, date }
});
var isUntouchedInstance = (task, series) => task.title === series.template.title && task.notes === series.template.notes && !task.subtasks.some((subtask) => subtask.done);

// src/domain/rollover.ts
var planRollover = (state, today) => {
  const stale = Object.values(state.tasks).filter((task) => !task.deletedAt && !task.archivedAt && !task.completedAt && task.placement.kind === "day" && task.placement.date < today).sort((a, b) => dayOf(a).localeCompare(dayOf(b)) || a.position - b.position);
  if (stale.length === 0)
    return null;
  const threshold = state.settings.archiveAfterRollovers;
  const archived = [];
  const superseded = [];
  const carried = [];
  const seriesToday = new Set(Object.values(state.tasks).filter((task) => task.recurrence && !task.deletedAt && task.placement.kind === "day" && task.placement.date === today).map((task) => task.recurrence.seriesId));
  for (const task of stale) {
    const series = task.recurrence ? state.series[task.recurrence.seriesId] : undefined;
    if (series && seriesToday.has(series.id) && isUntouchedInstance(task, series) && trackedMinutes(state, task.id) === 0) {
      superseded.push(task.id);
      continue;
    }
    const count = task.rolloverCount + Math.max(1, daysBetween(dayOf(task), today));
    if (threshold !== null && count >= threshold)
      archived.push(task.id);
    else
      carried.push(task);
  }
  const first = tasksForDay(state, today)[0]?.position;
  const moved = carried.map((task, index) => ({
    taskId: task.id,
    from: dayOf(task),
    position: first === undefined ? (index + 1) * 1024 : first - (carried.length - index) * 1024
  }));
  return { type: "tasks.rolledOver", date: today, moved, archived, ...superseded.length ? { superseded } : {} };
};
var dayOf = (task) => task.placement.kind === "day" ? task.placement.date : "";

// src/domain/activity.ts
var touchesTask = (event, taskId) => {
  if (event.type === "task.created")
    return event.task.id === taskId;
  if (event.type === "tasks.rolledOver")
    return event.moved.some((item) => item.taskId === taskId) || event.archived.includes(taskId) || (event.superseded ?? []).includes(taskId);
  if (event.type === "run.started")
    return event.run.taskId === taskId;
  return "taskId" in event && event.taskId === taskId;
};

// src/domain/ids.ts
var ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
var newId = (now = Date.now()) => {
  const random = new Uint8Array(10);
  crypto.getRandomValues(random);
  let suffix = "";
  for (const byte of random)
    suffix += ALPHABET[byte % 36];
  return now.toString(36).padStart(9, "0") + suffix;
};

// service/planner.ts
var summarize = (events, titleOf) => {
  if (events.length > 1)
    return `${events.length} changes`;
  const event = events[0];
  switch (event.type) {
    case "task.created":
      return `Add task: ${event.task.title}`;
    case "task.updated":
      return `Edit task: ${titleOf(event.taskId)}`;
    case "task.moved":
      return `Move task: ${titleOf(event.taskId)} → ${event.placement.kind === "day" ? event.placement.date : event.placement.bucket}`;
    case "task.completed":
      return `Complete task: ${titleOf(event.taskId)}`;
    case "task.reopened":
      return `Reopen task: ${titleOf(event.taskId)}`;
    case "task.deleted":
      return `Delete task: ${titleOf(event.taskId)}`;
    case "task.restored":
      return `Restore task: ${titleOf(event.taskId)}`;
    case "task.archived":
      return `Archive task: ${titleOf(event.taskId)}`;
    case "task.sourceSynced":
      return `Sync ${event.source.key}: ${event.source.status?.name ?? ""}`.trim();
    case "tasks.rolledOver":
      return `Roll over ${event.moved.length} tasks to ${event.date}${event.archived.length ? `, archive ${event.archived.length}` : ""}${event.superseded?.length ? `, replace ${event.superseded.length} repeats` : ""}`;
    case "tasks.recurred":
      return `Create ${event.instances.length} recurring instances`;
    case "series.created":
      return `Repeat: ${event.series.template.title}`;
    case "series.updated":
      return "Edit recurring task";
    case "series.stopped":
      return `Stop repeating from ${event.from}`;
    case "timer.started":
      return `Start timer: ${titleOf(event.taskId)}`;
    case "timer.stopped":
      return "Stop timer";
    case "time.logged":
      return `Log time: ${titleOf(event.entry.taskId)}`;
    case "time.deleted":
      return "Delete time entry";
    case "block.created":
      return `Timebox: ${titleOf(event.block.taskId)}`;
    case "block.updated":
      return "Move working session";
    case "block.deleted":
      return "Remove working session";
    case "block.linked":
      return event.google ? "Write a working session to Google Calendar" : "Unlink a working session from Google Calendar";
    case "objective.created":
      return `Add objective: ${event.objective.title}`;
    case "objective.updated":
      return "Edit objective";
    case "objective.deleted":
      return "Delete objective";
    case "ritual.saved":
      return `Save ${event.ritual} for ${event.date}`;
    case "calendar.added":
      return `Subscribe to calendar: ${event.calendar.name}`;
    case "calendar.updated":
      return "Edit calendar";
    case "calendar.removed":
      return "Remove calendar";
    case "folder.created":
      return `Add folder: ${event.folder.name}`;
    case "folder.renamed":
      return `Rename folder: ${event.name}`;
    case "folder.deleted":
      return "Delete folder";
    case "run.started":
      return `${event.run.wantsPr ? "Assign to agent" : "Start agent"}: ${titleOf(event.run.taskId)}`;
    case "run.outcome":
      return `Agent run ${event.outcome}`;
    case "run.reviewed":
      return `Review agent run: ${event.verdict}`;
    case "run.removed":
      return "Unlink agent run";
    case "run.pullRequest":
      return `Pull request ${event.pullRequest.repo}#${event.pullRequest.number} ${event.pullRequest.state}: ${titleOf(event.taskId)}`;
    case "channel.created":
      return `Add channel: ${event.channel.name}`;
    case "channel.updated":
      return `Edit channel: ${event.channelId}`;
    case "channel.deleted":
      return `Delete channel: ${event.channelId}`;
    case "settings.updated":
      return `Update settings: ${Object.keys(event.patch).join(", ")}`;
    case "gtask.kept":
      return `Keep for a Google task: ${Object.keys(event.patch).join(", ")}`;
    case "gtask.moved":
      return "A Google task moved";
    case "gtask.dropped":
      return "Forget a Google task";
  }
};
var DEFAULT_CHANNELS = [
  { type: "channel.created", channel: { id: "work", name: "work", color: "#e8590c", context: "work" } },
  { type: "channel.created", channel: { id: "personal", name: "personal", color: "#1c7ed6", context: "personal" } }
];

class Planner {
  store;
  now;
  state;
  applied = new Set;
  log;
  lastAt = 0;
  persistListeners = new Set;
  reloadedAt = 0;
  constructor(store, now = () => new Date) {
    this.store = store;
    this.now = now;
    const events = store.load();
    this.log = events;
    for (const event of events) {
      if (event.cmd)
        this.applied.add(event.cmd);
      this.lastAt = Math.max(this.lastAt, Date.parse(event.at) || 0);
    }
    this.state = foldEvents(events);
    if (events.length === 0)
      this.persist(DEFAULT_CHANNELS.map((body) => this.toEvent(body)));
  }
  today() {
    const zone = this.state.settings.timezone;
    return zone ? todayIn(zone, this.now()) : null;
  }
  ensureRollover() {
    const today = this.today();
    if (!today)
      return;
    const body = planRollover(this.state, today);
    if (body)
      this.persist([this.toEvent(body)]);
  }
  ensureRecurrence() {
    const today = this.today();
    if (!today)
      return;
    const instances = planInstances(this.state, today);
    if (instances.length)
      this.persist([this.toEvent({ type: "tasks.recurred", instances })]);
  }
  snapshot() {
    this.ensureRecurrence();
    this.ensureRollover();
    return {
      state: this.state,
      today: this.today(),
      storage: {
        dir: this.store.dir,
        git: this.store.hasGit,
        lastCommitAt: this.store.lastCommitAt,
        lastError: this.store.lastError,
        skippedLines: this.store.skippedLines
      }
    };
  }
  execute(commands) {
    let working = this.state;
    const events = [];
    for (let index = 0;index < commands.length; index++) {
      const command = commands[index];
      if (command && typeof command === "object" && typeof command.cmd === "string" && this.applied.has(command.cmd))
        continue;
      const error = validateCommand(command, working);
      if (error)
        return { ok: false, error, index };
      const event = this.toEvent(commandBody(command), command.cmd);
      events.push(event);
      working = applyEvents(working, [event]);
    }
    if (events.length)
      this.persist(events, working);
    return { ok: true, applied: events.length };
  }
  reload() {
    const events = this.store.load();
    this.log.length = 0;
    this.log.push(...events);
    this.applied.clear();
    for (const event of events) {
      if (event.cmd)
        this.applied.add(event.cmd);
      this.lastAt = Math.max(this.lastAt, Date.parse(event.at) || 0);
    }
    this.state = foldEvents(events);
    this.reloadedAt = Date.now();
  }
  onPersist(listener) {
    this.persistListeners.add(listener);
    return () => this.persistListeners.delete(listener);
  }
  activity(taskId, limit = 200) {
    return this.log.filter((event) => touchesTask(event, taskId)).slice(-limit);
  }
  persist(events, next) {
    const before = this.state;
    this.store.append(events, summarize(events, (id) => (next ?? before).tasks[id]?.title ?? before.tasks[id]?.title ?? id));
    this.state = next ?? applyEvents(before, events);
    this.log.push(...events);
    for (const event of events)
      if (event.cmd)
        this.applied.add(event.cmd);
    for (const listener of this.persistListeners) {
      try {
        listener(events, before, this.state);
      } catch (error) {
        console.error(`[planner] after a write: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  toEvent(body, cmd) {
    const at = Math.max(this.now().getTime(), this.lastAt + 1);
    this.lastAt = at;
    return { v: 1, id: newId(at), at: new Date(at).toISOString(), ...cmd ? { cmd } : {}, ...body };
  }
}

// service/calendars.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
import { fileURLToPath } from "node:url";

// src/domain/ics.ts
var WINDOWS_ZONES = {
  "pacific standard time": "America/Los_Angeles",
  "mountain standard time": "America/Denver",
  "central standard time": "America/Chicago",
  "eastern standard time": "America/New_York",
  "atlantic standard time": "America/Halifax",
  "gmt standard time": "Europe/London",
  "w. europe standard time": "Europe/Berlin",
  "romance standard time": "Europe/Paris",
  "central europe standard time": "Europe/Budapest",
  "china standard time": "Asia/Shanghai",
  "taipei standard time": "Asia/Taipei",
  "tokyo standard time": "Asia/Tokyo",
  "korea standard time": "Asia/Seoul",
  "singapore standard time": "Asia/Singapore",
  "india standard time": "Asia/Kolkata",
  "aus eastern standard time": "Australia/Sydney",
  utc: "UTC",
  "coordinated universal time": "UTC"
};
var resolveZone = (tzid) => {
  if (!tzid)
    return null;
  const clean = tzid.replace(/^"|"$/g, "").trim();
  if (isValidTimeZone(clean))
    return clean;
  const windows = WINDOWS_ZONES[clean.toLowerCase()];
  if (windows)
    return windows;
  const tail = clean.split("/").slice(-2).join("/");
  return isValidTimeZone(tail) ? tail : null;
};
var parseIcsTime = (value, params = {}) => {
  const text = value.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (date || params.VALUE === "DATE") {
    const match = date ?? /^(\d{4})(\d{2})(\d{2})/.exec(text);
    if (!match)
      return null;
    const key = `${match[1]}-${match[2]}-${match[3]}`;
    return isDateKey(key) ? { date: key, minutes: 0, zone: null, allDay: true } : null;
  }
  const time = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(text);
  if (!time)
    return null;
  const key = `${time[1]}-${time[2]}-${time[3]}`;
  if (!isDateKey(key))
    return null;
  const minutes = Number(time[4]) * 60 + Number(time[5]) + Number(time[6] ?? 0) / 60;
  return { date: key, minutes, zone: time[7] ? "UTC" : resolveZone(params.TZID), allDay: false };
};
var parseDurationIcs = (value) => {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!match)
    return null;
  const [, sign, w, d, h, m, s] = match;
  const ms = ((Number(w ?? 0) * 7 + Number(d ?? 0)) * 86400 + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0)) * 1000;
  return sign === "-" ? -ms : ms;
};
var unescapeText = (value) => value.replace(/\\n/gi, `
`).replace(/\\([,;\\])/g, "$1");
var parseLine = (line) => {
  let inQuotes = false;
  let colon = -1;
  for (let index = 0;index < line.length; index++) {
    const char = line[index];
    if (char === '"')
      inQuotes = !inQuotes;
    else if (char === ":" && !inQuotes) {
      colon = index;
      break;
    }
  }
  if (colon < 0)
    return null;
  const [rawName, ...rawParams] = line.slice(0, colon).split(";");
  const params = {};
  for (const param of rawParams) {
    const eq = param.indexOf("=");
    if (eq > 0)
      params[param.slice(0, eq).toUpperCase()] = param.slice(eq + 1);
  }
  return { name: (rawName ?? "").toUpperCase(), params, value: line.slice(colon + 1) };
};
var parseIcs = (text) => {
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const events = [];
  let current = null;
  let depth = 0;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line)
      continue;
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      current = { exdates: [] };
      depth = 0;
      continue;
    }
    if (!current)
      continue;
    if (upper.startsWith("BEGIN:")) {
      depth++;
      continue;
    }
    if (upper.startsWith("END:")) {
      if (upper === "END:VEVENT" && depth === 0) {
        if (current.start) {
          events.push({
            uid: current.uid ?? `${current.start.date}-${events.length}`,
            summary: current.summary ?? "(No title)",
            location: current.location ?? "",
            start: current.start,
            end: current.end ?? null,
            durationMs: current.durationMs ?? null,
            rrule: current.rrule ?? null,
            exdates: current.exdates,
            recurrenceId: current.recurrenceId ?? null,
            cancelled: current.cancelled ?? false,
            free: current.free ?? false
          });
        }
        current = null;
      } else
        depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0)
      continue;
    const property = parseLine(line);
    if (!property)
      continue;
    switch (property.name) {
      case "UID":
        current.uid = property.value;
        break;
      case "SUMMARY":
        current.summary = unescapeText(property.value);
        break;
      case "LOCATION":
        current.location = unescapeText(property.value);
        break;
      case "DTSTART":
        current.start = parseIcsTime(property.value, property.params) ?? undefined;
        break;
      case "DTEND":
        current.end = parseIcsTime(property.value, property.params);
        break;
      case "DURATION":
        current.durationMs = parseDurationIcs(property.value);
        break;
      case "RECURRENCE-ID":
        current.recurrenceId = parseIcsTime(property.value, property.params);
        break;
      case "STATUS":
        current.cancelled = property.value.toUpperCase() === "CANCELLED";
        break;
      case "TRANSP":
        current.free = property.value.toUpperCase() === "TRANSPARENT";
        break;
      case "EXDATE":
        for (const value of property.value.split(",")) {
          const time = parseIcsTime(value, property.params);
          if (time)
            current.exdates.push(time);
        }
        break;
      case "RRULE": {
        const rule = {};
        for (const part of property.value.split(";")) {
          const [key, value] = part.split("=");
          if (key && value)
            rule[key.toUpperCase()] = value.toUpperCase();
        }
        current.rrule = rule;
        break;
      }
    }
  }
  return events;
};
var icsInstant = (time, userZone) => Date.parse(instantAt(time.date, time.allDay ? 0 : time.minutes, time.allDay ? userZone : time.zone ?? userZone));
var WEEKDAY_CODES2 = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
var MAX_OCCURRENCES = 5000;
var daysInMonth3 = (year, month) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
var keyOf = (year, month, day) => `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
var nthWeekdayOfMonth = (year, month, day, n) => {
  const total = daysInMonth3(year, month);
  const matches = [];
  for (let d = 1;d <= total; d++)
    if (new Date(Date.UTC(year, month, d)).getUTCDay() === day)
      matches.push(d);
  const pick = n > 0 ? matches[n - 1] : matches[matches.length + n];
  return pick ? keyOf(year, month, pick) : null;
};
var recurrenceDates = (start, rule, lastDate, userZone) => {
  const interval = Math.max(1, Number(rule.INTERVAL ?? 1) || 1);
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
  const untilTime = rule.UNTIL ? parseIcsTime(rule.UNTIL) : null;
  const until = untilTime ? untilTime.allDay ? icsInstant({ ...untilTime, minutes: 24 * 60 - 1, allDay: false, zone: start.zone }, userZone) : icsInstant(untilTime, userZone) : Infinity;
  const out = [];
  let produced = 0;
  let done = false;
  const take = (date) => {
    if (done || date < start.date)
      return;
    if (date > lastDate || produced >= count || icsInstant({ ...start, date }, userZone) > until) {
      done = true;
      return;
    }
    produced++;
    out.push(date);
  };
  const byDay = (rule.BYDAY ?? "").split(",").filter(Boolean);
  const [startYear, startMonth] = start.date.split("-").map(Number);
  const startDay = Number(start.date.slice(8));
  switch (rule.FREQ) {
    case "DAILY":
      for (let date = start.date, guard = 0;!done && guard < MAX_OCCURRENCES * interval; date = addDays(date, interval), guard++)
        take(date);
      break;
    case "WEEKLY": {
      const weekStartsOn = rule.WKST === "SU" ? 0 : 1;
      const days = byDay.length ? byDay.map((code) => WEEKDAY_CODES2[code.slice(-2)]).filter((day) => day !== undefined) : [weekday(start.date)];
      const offsets = [...new Set(days.map((day) => (day - weekStartsOn + 7) % 7))].sort((a, b) => a - b);
      for (let week = startOfWeek(start.date, weekStartsOn), guard = 0;!done && guard < MAX_OCCURRENCES; week = addDays(week, 7 * interval), guard++) {
        for (const offset of offsets)
          take(addDays(week, offset));
      }
      break;
    }
    case "MONTHLY": {
      const monthDays = (rule.BYMONTHDAY ?? "").split(",").filter(Boolean).map(Number);
      for (let index = 0, guard = 0;!done && guard < MAX_OCCURRENCES; index += interval, guard++) {
        const year = startYear + Math.floor((startMonth - 1 + index) / 12);
        const month = (startMonth - 1 + index) % 12;
        const candidates = [];
        if (byDay.length) {
          for (const code of byDay) {
            const match = /^([+-]?\d+)?([A-Z]{2})$/.exec(code);
            if (!match)
              continue;
            const day = WEEKDAY_CODES2[match[2]];
            const nth = match[1] ? Number(match[1]) : null;
            if (nth) {
              const date = nthWeekdayOfMonth(year, month, day, nth);
              if (date)
                candidates.push(date);
            } else {
              for (let d = 1;d <= daysInMonth3(year, month); d++)
                if (new Date(Date.UTC(year, month, d)).getUTCDay() === day)
                  candidates.push(keyOf(year, month, d));
            }
          }
        } else {
          for (const value of monthDays.length ? monthDays : [startDay]) {
            const total = daysInMonth3(year, month);
            const day = value < 0 ? total + value + 1 : value;
            if (day >= 1 && day <= total)
              candidates.push(keyOf(year, month, day));
          }
        }
        for (const date of [...new Set(candidates)].sort())
          take(date);
        if (keyOf(year, month, 1) > lastDate)
          done = true;
      }
      break;
    }
    case "YEARLY":
      for (let year = startYear, guard = 0;!done && guard < MAX_OCCURRENCES; year += interval, guard++) {
        const month = startMonth - 1;
        if (startDay <= daysInMonth3(year, month))
          take(keyOf(year, month, startDay));
        if (keyOf(year, 0, 1) > lastDate)
          done = true;
      }
      break;
    default:
      take(start.date);
  }
  return out;
};
var expandEvents = (events, calendarId, from, to, userZone) => {
  const rangeStart = Date.parse(instantAt(from, 0, userZone));
  const rangeEnd = Date.parse(instantAt(addDays(to, 1), 0, userZone));
  const overrides = new Map;
  for (const event of events) {
    if (event.recurrenceId)
      overrides.set(`${event.uid}|${icsInstant(event.recurrenceId, userZone)}`, event);
  }
  const masters = new Set(events.filter((event) => !event.recurrenceId).map((event) => event.uid));
  const out = [];
  const emit = (event, start, occurrenceKey) => {
    if (event.cancelled)
      return;
    const startMs = icsInstant(start, userZone);
    let endMs;
    if (event.start.allDay) {
      const days = event.end?.allDay ? Math.max(1, daysBetween(event.start.date, event.end.date)) : Math.max(1, Math.round((event.durationMs ?? 86400000) / 86400000));
      endMs = Date.parse(instantAt(addDays(start.date, days), 0, userZone));
    } else {
      const length = event.end ? icsInstant(event.end, userZone) - icsInstant(event.start, userZone) : event.durationMs ?? 3600000;
      endMs = startMs + Math.max(0, length);
    }
    if (endMs <= rangeStart || startMs >= rangeEnd)
      return;
    out.push({
      id: `${calendarId}:${event.uid}:${occurrenceKey}`,
      calendarId,
      title: event.summary,
      location: event.location,
      start: new Date(startMs).toISOString(),
      end: new Date(Math.max(endMs, startMs)).toISOString(),
      allDay: event.start.allDay,
      busy: !event.free && !event.start.allDay
    });
  };
  for (const event of events) {
    if (event.recurrenceId) {
      if (!masters.has(event.uid))
        emit(event, event.start, String(icsInstant(event.start, userZone)));
      continue;
    }
    if (!event.rrule) {
      emit(event, event.start, "single");
      continue;
    }
    const excluded = new Set(event.exdates.map((time) => time.allDay ? `d:${time.date}` : `t:${icsInstant(time, userZone)}`));
    for (const date of recurrenceDates(event.start, event.rrule, to, userZone)) {
      const occurrence = { ...event.start, date };
      const instant = icsInstant(occurrence, userZone);
      if (excluded.has(`d:${date}`) || excluded.has(`t:${instant}`))
        continue;
      const override = overrides.get(`${event.uid}|${instant}`);
      if (override)
        emit(override, override.start, String(instant));
      else
        emit(event, occurrence, String(instant));
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
};

// service/calendars.ts
var TTL_MS = 10 * 60000;
var TIMEOUT_MS = 15000;
var MAX_CHARS = 1e7;

class CalendarFeeds {
  cacheDir;
  fetcher;
  cache = new Map;
  constructor(cacheDir, fetcher = fetch) {
    this.cacheDir = cacheDir;
    this.fetcher = fetcher;
    mkdirSync2(cacheDir, { recursive: true });
  }
  async eventsFor(calendars, from, to, zone, refresh = false) {
    const result = { events: [], errors: [] };
    await Promise.all(calendars.filter((calendar) => calendar.visible).map(async (calendar) => {
      try {
        const events = await this.load(calendar, refresh);
        result.events.push(...expandEvents(events, calendar.id, from, to, zone));
      } catch (error) {
        result.errors.push({ calendarId: calendar.id, message: error instanceof Error ? error.message : String(error) });
      }
    }));
    result.events.sort((a, b) => a.start.localeCompare(b.start));
    return result;
  }
  async load(calendar, refresh) {
    const hit = this.cache.get(calendar.id);
    if (hit && hit.url === calendar.url && !refresh && Date.now() - hit.fetchedAt < TTL_MS)
      return hit.events;
    const copy = join2(this.cacheDir, `${calendar.id}.ics`);
    let text;
    try {
      text = await this.fetchText(calendar.url);
      writeFileSync2(copy, text);
    } catch (error) {
      if (hit && hit.url === calendar.url)
        return hit.events;
      if (!existsSync2(copy))
        throw error;
      text = readFileSync2(copy, "utf8");
    }
    const events = parseIcs(text);
    this.cache.set(calendar.id, { url: calendar.url, fetchedAt: Date.now(), events });
    return events;
  }
  async fetchText(url) {
    const target = url.replace(/^webcal:/i, "https:");
    let text;
    if (/^file:/i.test(target)) {
      text = readFileSync2(fileURLToPath(target), "utf8");
    } else {
      const controller = new AbortController;
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await this.fetcher(target, { signal: controller.signal, headers: { accept: "text/calendar, */*" } });
        if (!response.ok)
          throw new Error(`calendar feed answered HTTP ${response.status}`);
        text = await response.text();
      } finally {
        clearTimeout(timer);
      }
    }
    if (text.length > MAX_CHARS)
      throw new Error("calendar feed is too large");
    if (!/BEGIN:VCALENDAR/i.test(text))
      throw new Error("not an iCalendar feed");
    return text;
  }
}

// service/sync.ts
var isRemoteUrl = (url) => {
  if (!url || url.length > 500 || /\s/.test(url) || url.startsWith("-"))
    return false;
  return /^(https|ssh|git|file):\/\/\S+$/i.test(url) || /^[\w.-]+@[\w.-]+:[\w.~/-]+$/.test(url) || /^\/[^\0]+$/.test(url);
};
var AUTO_DELAY_MS = 15000;
var PERIOD_MS = 5 * 60000;

class SyncManager {
  store;
  planner;
  log;
  remote = null;
  lastSyncAt = null;
  lastError = null;
  running = null;
  lock = null;
  timer = null;
  constructor(store, planner, log = () => {}) {
    this.store = store;
    this.planner = planner;
    this.log = log;
  }
  async init() {
    this.remote = await this.store.remoteUrl();
    if (this.remote)
      this.schedule(5000);
    setInterval(() => {
      if (this.remote)
        this.run().catch(() => {
          return;
        });
    }, PERIOD_MS).unref?.();
  }
  status() {
    return { remote: this.remote, lastSyncAt: this.lastSyncAt, lastError: this.lastError, syncing: this.running !== null };
  }
  idle() {
    return this.lock ?? Promise.resolve();
  }
  schedule(delay = AUTO_DELAY_MS) {
    if (!this.remote)
      return;
    if (this.timer)
      clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run().catch(() => {
        return;
      });
    }, delay);
    this.timer.unref?.();
  }
  async setRemote(url) {
    const clean = url?.trim() || null;
    if (clean && !isRemoteUrl(clean))
      throw new Error("Use an https, ssh, git@host:path, file:// URL or an absolute path.");
    await this.store.setRemote(clean);
    this.remote = clean;
    this.lastError = null;
    this.lastSyncAt = null;
    if (clean)
      this.schedule(1000);
    return this.status();
  }
  run() {
    if (!this.remote)
      return Promise.reject(new Error("No sync remote is set."));
    this.running ??= this.sync().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  async sync() {
    try {
      await this.store.fetchRemote();
      let release;
      this.lock = new Promise((resolve) => {
        release = resolve;
      });
      try {
        await this.store.commitNow();
        if (await this.store.mergeRemote())
          this.planner.reload();
      } finally {
        this.lock = null;
        release();
      }
      await this.store.pushRemote();
      this.lastSyncAt = new Date().toISOString();
      this.lastError = null;
    } catch (error) {
      this.lastError = (error instanceof Error ? error.message : String(error)).split(`
`).slice(0, 3).join(" ").slice(0, 400);
      this.log(`sync failed: ${this.lastError}`);
    }
    return { ...this.status(), syncing: false };
  }
}

// service/github.ts
import { execFile as execFile2 } from "node:child_process";
import { existsSync as existsSync3 } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute } from "node:path";
var GH_TIMEOUT_MS = 15000;
var ghRunner = (args, options) => new Promise((resolve, reject) => {
  execFile2("gh", args, { timeout: options?.timeoutMs ?? GH_TIMEOUT_MS, maxBuffer: 8000000, ...options?.cwd ? { cwd: options.cwd } : {} }, (error, stdout, stderr) => {
    if (error)
      reject(Object.assign(new Error(`${error.message}
${stderr}`), { code: error.code, stderr: String(stderr) }));
    else
      resolve(stdout);
  });
});
var ITEM_FIELDS = `__typename
  ... on Issue { id number title url state updatedAt repository { nameWithOwner } }
  ... on PullRequest { id number title url state isDraft updatedAt repository { nameWithOwner } }`;
var LIST_QUERY = `query PlannerGitHubList($q: String!) { search(query: $q, type: ISSUE, first: 50) { nodes { ${ITEM_FIELDS} } } }`;
var NODES_QUERY = `query PlannerGitHubNodes($ids: [ID!]!) { nodes(ids: $ids) { ${ITEM_FIELDS} } }`;
var LISTS = {
  assigned: "is:open is:issue assignee:@me archived:false sort:updated-desc",
  review: "is:open is:pr review-requested:@me archived:false sort:updated-desc",
  mine: "is:open is:pr author:@me archived:false sort:updated-desc"
};
var parseNodes = (nodes) => nodes.flatMap((node) => {
  if (!node?.id || !node.number || !node.title || !node.url || !node.repository?.nameWithOwner)
    return [];
  const kind = node.__typename === "PullRequest" ? "pull" : "issue";
  return [{
    id: node.id,
    kind,
    repo: node.repository.nameWithOwner,
    number: node.number,
    key: `${node.repository.nameWithOwner}#${node.number}`,
    title: node.title,
    url: node.url,
    state: node.state ?? "OPEN",
    draft: Boolean(node.isDraft),
    updatedAt: node.updatedAt ?? ""
  }];
});
var PULL_FIELDS = "number,url,state,isDraft,title,updatedAt";
var PULL_URL2 = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})\/pull\/\d{1,9}$/;
var BRANCH = /^(?![-/.])(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}(?<![/.])$/;
var pickPull = (pulls) => {
  const rank = { open: 0, merged: 1, closed: 2 };
  const parsed = pulls.flatMap((pull) => {
    const match = PULL_URL2.exec(pull.url ?? "");
    const state = pull.state?.toLowerCase();
    if (!match || !pull.number || !pull.title || !(state === "open" || state === "merged" || state === "closed"))
      return [];
    return [{ pr: { number: pull.number, url: pull.url, state, draft: Boolean(pull.isDraft), title: pull.title.slice(0, 500), repo: match[1] }, updatedAt: pull.updatedAt ?? "" }];
  });
  return parsed.sort((a, b) => rank[a.pr.state] - rank[b.pr.state] || b.updatedAt.localeCompare(a.updatedAt))[0]?.pr ?? null;
};
var diagnose = (error) => {
  const failure = error;
  if (failure.code === "ENOENT")
    return { reason: "missing", message: "The GitHub CLI (gh) is not installed where OpenChamber runs. Install it there, then sign in with `gh auth login`." };
  const text = `${failure.stderr ?? ""} ${failure.message ?? ""}`;
  if (/auth login|not logged|authentication|GH_TOKEN|bad credentials|HTTP 401/i.test(text)) {
    return { reason: "signed-out", message: "The GitHub CLI (gh) is not signed in. Run `gh auth login` once where OpenChamber runs; a GH_TOKEN set for OpenChamber does not reach the Planner." };
  }
  return { reason: null, message: text.trim().split(`
`)[0]?.slice(0, 300) || "gh failed" };
};
var explain = (error) => diagnose(error).message;
var containerId = () => {
  if (!existsSync3("/.dockerenv") && !existsSync3("/run/.containerenv"))
    return null;
  const name = hostname();
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : null;
};

class GitHubSource {
  run;
  container;
  constructor(run = ghRunner, container = containerId) {
    this.run = run;
    this.container = container;
  }
  async status() {
    try {
      const login = (await this.run(["api", "user", "--jq", ".login"])).trim();
      return { available: true, login: login || null, message: null, reason: null, container: null };
    } catch (error) {
      const { reason, message } = diagnose(error);
      return { available: false, login: null, message, reason, container: reason ? this.container() : null };
    }
  }
  async list(kind) {
    const out = await this.run(["api", "graphql", "-f", `query=${LIST_QUERY}`, "-f", `q=${LISTS[kind]}`]).catch((error) => {
      throw new Error(explain(error));
    });
    return parseNodes(JSON.parse(out).data?.search?.nodes ?? []);
  }
  async pullRequestFor(branch, directories) {
    if (!BRANCH.test(branch))
      throw new Error("branch name is invalid");
    let failure = null;
    for (const directory of directories) {
      if (!isAbsolute(directory) || !existsSync3(directory))
        continue;
      try {
        const out = await this.run(["pr", "list", "--head", branch, "--state", "all", "--limit", "10", "--json", PULL_FIELDS], { cwd: directory, timeoutMs: 8000 });
        return pickPull(JSON.parse(out));
      } catch (error) {
        failure = error;
      }
    }
    if (failure)
      throw new Error(explain(failure));
    return null;
  }
  async pullRequestAt(url) {
    if (!PULL_URL2.test(url))
      throw new Error("pull request URL is invalid");
    const out = await this.run(["pr", "view", url, "--json", PULL_FIELDS], { timeoutMs: 8000 }).catch((error) => {
      throw new Error(explain(error));
    });
    return pickPull([JSON.parse(out)]);
  }
  async items(ids) {
    if (ids.length === 0)
      return [];
    const out = await this.run(["api", "graphql", "-f", `query=${NODES_QUERY}`, ...ids.slice(0, 100).flatMap((id) => ["-f", `ids[]=${id}`])]).catch((error) => {
      throw new Error(explain(error));
    });
    return parseNodes(JSON.parse(out).data?.nodes ?? []);
  }
}

// service/linear.ts
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// src/domain/linear.ts
var ISSUE_INPUT_KEYS = ["title", "description", "stateId", "priority", "assigneeId", "dueDate", "addedLabelIds", "removedLabelIds", "projectId", "cycleId", "estimate"];
var ISSUE_FIELDS = `id identifier title url priority prioritySortOrder sortOrder estimate dueDate createdAt updatedAt completedAt canceledAt branchName
    state { id name type color position }
    team { id key name }
    assignee { id name }
    creator { id name }
    project { id name color icon }
    cycle { id number name isActive isNext }
    projectMilestone { id name }
    parent { id identifier title }
    labels(first: 25) { nodes { id name color } }
    syncedWith { service metadata { ... on ExternalEntityInfoGithubMetadata { owner repo number } } }`;
var PAGE = "pageInfo { hasNextPage endCursor }";
var PROJECT_FIELDS = `id name url color icon description progress health priority startDate targetDate createdAt updatedAt sortOrder
    status { id name type color }
    lead { id name }
    teams(first: 10) { nodes { id key name } }`;
var ASSIGNED_QUERY = `query PlannerAssigned($after: String, $filter: IssueFilter) {
  viewer {
    id
    name
    assignedIssues(first: 100, after: $after, orderBy: updatedAt, filter: $filter) {
      nodes { ${ISSUE_FIELDS} }
      ${PAGE}
    }
  }
}`;
var CREATED_QUERY = `query PlannerCreated($after: String, $filter: IssueFilter) {
  viewer {
    id
    createdIssues(first: 100, after: $after, orderBy: updatedAt, filter: $filter) {
      nodes { ${ISSUE_FIELDS} }
      ${PAGE}
    }
  }
}`;
var ISSUES_QUERY = `query PlannerIssues($after: String, $filter: IssueFilter) {
  issues(first: 100, after: $after, orderBy: updatedAt, filter: $filter) {
    nodes { ${ISSUE_FIELDS} }
    ${PAGE}
  }
}`;
var VIEW_FIELDS = `id name description icon color shared modelName slugId updatedAt
    team { id key name }
    owner { id name }`;
var VIEWS_QUERY = `query PlannerViews($after: String) {
  customViews(first: 100, after: $after) {
    nodes { ${VIEW_FIELDS} }
    ${PAGE}
  }
}`;
var FAVORITE_VIEWS_QUERY = `query PlannerFavoriteViews {
  favorites(first: 250) {
    nodes {
      id type sortOrder
      customView { id }
      project { ${PROJECT_FIELDS} }
      issue { id identifier title url state { id name type color } team { id key name } }
    }
  }
}`;
var VIEW_QUERY = `query PlannerView($id: String!) {
  customView(id: $id) {
    ${VIEW_FIELDS}
    filterData
    viewPreferencesValues { ${VIEW_PREF_FIELDS} }
  }
}`;
var VIEW_ISSUES_QUERY = `query PlannerViewIssues($id: String!, $after: String, $filter: IssueFilter) {
  customView(id: $id) {
    id
    issues(first: 100, after: $after, orderBy: updatedAt, filter: $filter) {
      nodes { ${ISSUE_FIELDS} }
      ${PAGE}
    }
  }
}`;
var VIEW_PROJECTS_QUERY = `query PlannerViewProjects($id: String!, $after: String, $filter: ProjectFilter) {
  customView(id: $id) {
    id
    projects(first: 50, after: $after, filter: $filter) {
      nodes { ${PROJECT_FIELDS} }
      ${PAGE}
    }
  }
}`;
var SEARCH_QUERY = `query PlannerSearch($term: String!, $after: String, $filter: IssueFilter) {
  searchIssues(term: $term, first: 50, after: $after, filter: $filter) {
    nodes { ${ISSUE_FIELDS} }
    ${PAGE}
  }
}`;
var LINKED_QUERY = `query PlannerLinked($ids: [ID!]!) {
  issues(first: 100, filter: { id: { in: $ids } }) { nodes { ${ISSUE_FIELDS} } }
}`;
var ISSUE_QUERY = `query PlannerIssue($id: String!) {
  issue(id: $id) { ${ISSUE_FIELDS} }
}`;
var TEAM_STATES_QUERY = `query PlannerTeamStates($id: String!) {
  team(id: $id) { id states(first: 100) { nodes { id name type color position } } }
}`;
var TEAMS_QUERY = `query PlannerTeams {
  viewer { id }
  teams(first: 100) { nodes { id key name } }
}`;
var WHOAMI_QUERY = `query PlannerWhoAmI {
  viewer { id name }
  organization { id name urlKey }
}`;
var PROJECTS_QUERY = `query PlannerProjects($after: String) {
  projects(first: 50, after: $after, orderBy: updatedAt, filter: { status: { type: { nin: ["completed", "canceled"] } } }) {
    nodes { ${PROJECT_FIELDS} }
    ${PAGE}
  }
}`;
var PROJECT_QUERY = `query PlannerProject($id: String!) {
  project(id: $id) {
    ${PROJECT_FIELDS}
    content
    projectMilestones(first: 25) { nodes { id name targetDate progress sortOrder } }
    lastUpdate { id body health createdAt url user { id name } }
  }
}`;
var FILTER_TEAMS_QUERY = `query PlannerFilterTeams($after: String) {
  teams(first: 50, after: $after) {
    nodes { id key name issueEstimationType issueEstimationAllowZero issueEstimationExtended states(first: 50) { nodes { id name type color position } } }
    ${PAGE}
  }
}`;
var FILTER_MILESTONES_QUERY = `query PlannerFilterMilestones($after: String) {
  projectMilestones(first: 250, after: $after) {
    nodes { id name targetDate project { id name } }
    ${PAGE}
  }
}`;
var FILTER_USERS_QUERY = `query PlannerFilterUsers($after: String) {
  users(first: 250, after: $after, filter: { active: { eq: true } }) {
    nodes { id name displayName active isMe }
    ${PAGE}
  }
}`;
var FILTER_LABELS_QUERY = `query PlannerFilterLabels($after: String) {
  issueLabels(first: 250, after: $after) {
    nodes { id name color isGroup parent { id name } team { id key } }
    ${PAGE}
  }
}`;
var FILTER_PROJECTS_QUERY = `query PlannerFilterProjects($after: String) {
  projects(first: 250, after: $after) {
    nodes { id name color icon status { type } }
    ${PAGE}
  }
}`;
var FILTER_CYCLES_QUERY = `query PlannerFilterCycles($after: String) {
  cycles(first: 250, after: $after, filter: { endsAt: { gt: "-P8W" } }) {
    nodes { id number name startsAt endsAt isActive isNext team { id key } }
    ${PAGE}
  }
}`;
var COMMENT_FIELDS = `id body createdAt editedAt user { id name } botActor { name } parent { id }`;
var HISTORY_FIELDS = `id createdAt actor { id name } botActor { name }
      fromState { name color type } toState { name color type }
      fromAssignee { name } toAssignee { name }
      fromPriority toPriority fromTitle toTitle
      addedLabels { name color } removedLabels { name color }
      fromDueDate toDueDate fromProject { name } toProject { name }
      fromCycle { number name } toCycle { number name }
      fromEstimate toEstimate updatedDescription`;
var DETAIL_FIELDS = `${ISSUE_FIELDS}
    description
    comments(first: 100) { nodes { ${COMMENT_FIELDS} } }
    children(first: 50) { nodes { id identifier title priority state { id name type color } assignee { id name } } }
    attachments(first: 25) { nodes { id title subtitle url sourceType } }
    history(first: 50) { nodes { ${HISTORY_FIELDS} } }`;
var ISSUE_DETAIL_QUERY = `query PlannerIssueDetail($id: String!) {
  issue(id: $id) { ${DETAIL_FIELDS} }
}`;
var TEAM_OPTIONS_QUERY = `query PlannerTeamOptions($id: String!) {
  team(id: $id) {
    id
    cyclesEnabled
    issueEstimationType
    issueEstimationAllowZero
    issueEstimationExtended
    states(first: 100) { nodes { id name type color position } }
    members(first: 250) { nodes { id name displayName active } }
    labels(first: 250, filter: { isGroup: { eq: false } }) { nodes { id name color } }
    cycles(first: 25, filter: { endsAt: { gt: "-P1D" } }) { nodes { id number name startsAt endsAt isActive isNext } }
    projects(first: 100, filter: { status: { type: { nin: ["completed", "canceled"] } } }) { nodes { id name color icon } }
  }
  issueLabels(first: 250, filter: { team: { null: true }, isGroup: { eq: false } }) { nodes { id name color } }
}`;
var UPDATE_ISSUE_MUTATION = `mutation PlannerUpdateIssue($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { ${DETAIL_FIELDS} } }
}`;
var ADD_COMMENT_MUTATION = `mutation PlannerAddComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { ${COMMENT_FIELDS} } }
}`;
var SET_STATE_MUTATION = `mutation PlannerSetState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { ${ISSUE_FIELDS} } }
}`;
var CREATE_ISSUE_MUTATION = `mutation PlannerCreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
}`;
var SAVE_VIEW_FILTER_MUTATION = `mutation PlannerSaveViewFilter($id: String!, $filterData: IssueFilter!) {
  customViewUpdate(id: $id, input: { filterData: $filterData }) { success customView { id updatedAt } }
}`;
var ALL_DOCUMENTS = [
  SAVE_VIEW_FILTER_MUTATION,
  ASSIGNED_QUERY,
  CREATED_QUERY,
  ISSUES_QUERY,
  VIEWS_QUERY,
  FAVORITE_VIEWS_QUERY,
  VIEW_QUERY,
  VIEW_ISSUES_QUERY,
  VIEW_PROJECTS_QUERY,
  SEARCH_QUERY,
  LINKED_QUERY,
  ISSUE_QUERY,
  TEAM_STATES_QUERY,
  TEAMS_QUERY,
  WHOAMI_QUERY,
  PROJECTS_QUERY,
  PROJECT_QUERY,
  FILTER_TEAMS_QUERY,
  FILTER_USERS_QUERY,
  FILTER_LABELS_QUERY,
  FILTER_PROJECTS_QUERY,
  FILTER_CYCLES_QUERY,
  FILTER_MILESTONES_QUERY,
  ISSUE_DETAIL_QUERY,
  TEAM_OPTIONS_QUERY,
  SET_STATE_MUTATION,
  CREATE_ISSUE_MUTATION,
  UPDATE_ISSUE_MUTATION,
  ADD_COMMENT_MUTATION
];
var MUTATION_INPUT_KEYS = new Map([
  [UPDATE_ISSUE_MUTATION, ISSUE_INPUT_KEYS],
  [ADD_COMMENT_MUTATION, ["issueId", "body"]],
  [CREATE_ISSUE_MUTATION, ["teamId", "title", "assigneeId", "priority", "description", "dueDate"]]
]);
var readGraphql = (body) => {
  const parsed = JSON.parse(body);
  if (parsed.errors?.length) {
    const error = parsed.errors[0];
    throw new Error(error.extensions?.userPresentableMessage ?? error.message ?? "Linear returned an error");
  }
  if (!parsed.data)
    throw new Error("Linear returned no data");
  return parsed.data;
};
var NON_ISSUE_MODELS = new Set(["project", "projects", "initiative", "initiatives", "feeditem", "feeditems", "customer", "customers", "document", "documents", "release", "releases"]);

// service/linear.ts
var LINEAR_API = "https://api.linear.app/graphql";
var TIMEOUT_MS2 = 20000;
var MAX_WORKSPACES = 20;
var ALLOWED = new Set(ALL_DOCUMENTS);

class WorkspaceError extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
var isStored = (value) => {
  const item = value;
  return Boolean(item) && ["id", "name", "urlKey", "account", "key", "addedAt"].every((field) => typeof item[field] === "string");
};
var publicInfo = ({ key: _key, ...info }) => info;
var authorization = (key) => key.startsWith("lin_oauth_") ? `Bearer ${key}` : key;

class LinearWorkspaces {
  file;
  fetcher;
  log;
  items = [];
  loaded = null;
  writes = Promise.resolve();
  constructor(file, fetcher = fetch, log = () => {}) {
    this.file = file;
    this.fetcher = fetcher;
    this.log = log;
  }
  async list() {
    await this.load();
    return this.items.map(publicInfo);
  }
  add(rawKey) {
    return this.serial(async () => {
      const key = rawKey.trim();
      if (!/^[A-Za-z0-9_-]{20,200}$/.test(key))
        throw new WorkspaceError(400, "That does not look like a Linear API key (Linear → Settings → Security & access → Personal API keys)");
      await this.load();
      const answer = await this.send(key, WHOAMI_QUERY, {});
      if (answer.status === 401 || answer.status === 403)
        throw new WorkspaceError(400, "Linear rejected the key");
      let data;
      try {
        data = readGraphql(answer.body);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new WorkspaceError(400, /authenticat/i.test(message) ? "Linear rejected the key" : `Linear answered: ${message}`);
      }
      const entry = { id: data.organization.id, name: data.organization.name, urlKey: data.organization.urlKey, account: data.viewer.name, key, addedAt: new Date().toISOString() };
      const index = this.items.findIndex((item) => item.id === entry.id);
      if (index < 0 && this.items.length >= MAX_WORKSPACES)
        throw new WorkspaceError(400, `At most ${MAX_WORKSPACES} workspaces`);
      this.items = index < 0 ? [...this.items, entry] : this.items.map((item, at) => at === index ? entry : item);
      await this.save();
      return publicInfo(entry);
    });
  }
  remove(id) {
    return this.serial(async () => {
      await this.load();
      const before = this.items.length;
      this.items = this.items.filter((item) => item.id !== id);
      if (this.items.length === before)
        return false;
      await this.save();
      return true;
    });
  }
  async graphql(id, query, variables) {
    if (!ALLOWED.has(query))
      throw new WorkspaceError(400, "only the Planner's own Linear queries can run");
    const keys = MUTATION_INPUT_KEYS.get(query);
    if (keys) {
      const input = variables?.input;
      if (typeof input !== "object" || input === null || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key))) {
        throw new WorkspaceError(400, "that change is not one the Planner makes");
      }
    }
    await this.load();
    const entry = this.items.find((item) => item.id === id);
    if (!entry)
      throw new WorkspaceError(404, "that Linear workspace is not connected");
    return this.send(entry.key, query, variables);
  }
  async send(key, query, variables) {
    let response;
    try {
      response = await this.fetcher(LINEAR_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authorization(key) },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(TIMEOUT_MS2)
      });
    } catch (error) {
      throw new WorkspaceError(502, `Could not reach Linear: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { status: response.status, body: await response.text() };
  }
  load() {
    this.loaded ??= (async () => {
      let text;
      try {
        text = await readFile(this.file, "utf8");
      } catch (error) {
        if (error.code === "ENOENT")
          return;
        throw error;
      }
      try {
        const parsed = JSON.parse(text);
        this.items = Array.isArray(parsed.workspaces) ? parsed.workspaces.filter(isStored) : [];
      } catch {
        this.log(`${this.file} is not readable JSON; Linear workspaces need to be added again`);
      }
    })();
    return this.loaded;
  }
  async save() {
    await mkdir(dirname(this.file), { recursive: true, mode: 448 });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify({ version: 1, workspaces: this.items }, null, 2)}
`, { mode: 384 });
    await chmod(temp, 384);
    await rename(temp, this.file);
  }
  serial(work) {
    const next = this.writes.then(work, work);
    this.writes = next.catch(() => {});
    return next;
  }
}

// service/google.ts
import { createHash, randomBytes } from "node:crypto";
import { chmod as chmod2, mkdir as mkdir2, readFile as readFile2, rename as rename2, writeFile as writeFile2 } from "node:fs/promises";
import http from "node:http";
import { dirname as dirname2 } from "node:path";
var GOOGLE_FEATURES = ["calendar", "tasks", "mail"];
var FEATURE_SCOPES = {
  calendar: ["https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events"],
  tasks: ["https://www.googleapis.com/auth/tasks"],
  mail: ["https://www.googleapis.com/auth/gmail.readonly"]
};
var IDENTITY_SCOPES = ["openid", "email"];
var AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
var TOKEN_URL = "https://oauth2.googleapis.com/token";
var REVOKE_URL = "https://oauth2.googleapis.com/revoke";
var API_ORIGINS = ["https://www.googleapis.com/", "https://tasks.googleapis.com/", "https://gmail.googleapis.com/"];
var TIMEOUT_MS3 = 12000;
var SIGN_IN_MS = 10 * 60000;
var MAX_ACCOUNTS = 10;
var CLIENT_ID = /^[0-9]{6,30}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com$/;

class GoogleError extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
var testFetcher = (base) => {
  if (!base || !/^http:\/\/127\.0\.0\.1:\d{2,5}\/$/.test(base))
    return null;
  return (url, init) => fetch(url.replace(/^https:\/\/[a-z0-9-]+\.googleapis\.com\//, base), init);
};
var defaultFetcher = testFetcher(process.env.PLANNER_GOOGLE_API_BASE) ?? fetch;
var loopbackListen = (onRequest) => new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/") {
      res.writeHead(404).end();
      return;
    }
    onRequest(url).then((page) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(page));
  });
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close: () => server.close() }));
});
var base64url = (bytes) => bytes.toString("base64url");
var page = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui;margin:3em;max-width:36em"><h1 style="font-size:20px">${title}</h1><p>${text}</p>`;
var featuresOf = (scopes) => GOOGLE_FEATURES.filter((feature) => FEATURE_SCOPES[feature].every((scope) => scopes.includes(scope)));
var emailFromIdToken = (idToken) => {
  const payload = idToken?.split(".")[1];
  if (!payload)
    return null;
  try {
    const email = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).email;
    return typeof email === "string" && /^[^\s@]+@[^\s@]+$/.test(email) ? email.toLowerCase() : null;
  } catch {
    return null;
  }
};
var googleMessage = (body, status) => {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed.error === "object" && parsed.error?.message)
      return parsed.error.message;
    if (parsed.error_description)
      return parsed.error_description;
    if (typeof parsed.error === "string")
      return parsed.error;
  } catch {}
  return `Google answered HTTP ${status}`;
};
var googleStatus = (status) => {
  if (status === 404 || status === 410)
    return 404;
  if (status === 400 || status === 403 || status === 409)
    return status;
  if (status === 412)
    return 409;
  return 502;
};
var isStoredAccount = (value) => {
  const item = value;
  return Boolean(item) && typeof item.email === "string" && typeof item.refreshToken === "string" && typeof item.addedAt === "string" && Array.isArray(item.scopes) && item.scopes.every((scope) => typeof scope === "string");
};
var publicInfo2 = (account) => ({ email: account.email, features: featuresOf(account.scopes), addedAt: account.addedAt });

class GoogleAccounts {
  file;
  fetcher;
  listen;
  log;
  client = null;
  accounts = [];
  loaded = null;
  writes = Promise.resolve();
  signIns = new Map;
  tokens = new Map;
  constructor(file, fetcher = defaultFetcher, listen = loopbackListen, log = () => {}) {
    this.file = file;
    this.fetcher = fetcher;
    this.listen = listen;
    this.log = log;
  }
  async status() {
    await this.load();
    return { client: this.client ? { id: this.client.id } : null, accounts: this.accounts.map(publicInfo2) };
  }
  setClient(rawId, rawSecret) {
    return this.serial(async () => {
      const id = rawId.trim();
      const secret = rawSecret.trim();
      if (!CLIENT_ID.test(id))
        throw new GoogleError(400, "That is not an OAuth client ID (it ends in .apps.googleusercontent.com)");
      if (!/^[A-Za-z0-9_-]{10,100}$/.test(secret))
        throw new GoogleError(400, "That does not look like the client secret Google shows with the client ID");
      await this.load();
      if (this.client && this.client.id !== id) {
        this.accounts = [];
        this.tokens.clear();
      }
      this.client = { id, secret };
      await this.save();
      return this.status();
    });
  }
  clearClient() {
    return this.serial(async () => {
      await this.load();
      for (const account of this.accounts)
        await this.revoke(account.refreshToken);
      this.client = null;
      this.accounts = [];
      this.tokens.clear();
      await this.save();
      return this.status();
    });
  }
  async startSignIn(features) {
    await this.load();
    if (!this.client)
      throw new GoogleError(400, "Add the OAuth client first");
    if (features.length === 0)
      throw new GoogleError(400, "Choose at least one of Calendar, Tasks and Gmail");
    this.expireSignIns();
    const id = base64url(randomBytes(12));
    const state = base64url(randomBytes(24));
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const listener = await this.listen((url) => this.callback(id, url));
    const redirectUri = `http://127.0.0.1:${listener.port}/`;
    const signIn = { state, verifier, redirectUri, expires: Date.now() + SIGN_IN_MS, result: { status: "pending" }, close: listener.close };
    this.signIns.set(id, signIn);
    setTimeout(() => this.endSignIn(id, { status: "failed", message: "The sign-in took too long; start it again" }), SIGN_IN_MS).unref?.();
    const scopes = [...IDENTITY_SCOPES, ...new Set(features.flatMap((feature) => FEATURE_SCOPES[feature]))];
    const query = new URLSearchParams({
      client_id: this.client.id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: scopes.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true"
    });
    return { id, authUrl: `${AUTH_URL}?${query}`, redirectUri };
  }
  signIn(id) {
    return this.signIns.get(id)?.result ?? { status: "failed", message: "That sign-in is over; start it again" };
  }
  async finishSignIn(id, pasted) {
    const signIn = this.signIns.get(id);
    if (!signIn || signIn.result.status !== "pending")
      return this.signIn(id);
    let url;
    try {
      url = new URL(pasted.trim());
    } catch {
      throw new GoogleError(400, "Paste the whole address from the browser, starting with http://127.0.0.1");
    }
    if (`${url.protocol}//${url.host}/` !== signIn.redirectUri)
      throw new GoogleError(400, `That address is not the one this sign-in waits for (${signIn.redirectUri})`);
    await this.callback(id, url);
    return this.signIn(id);
  }
  remove(email) {
    return this.serial(async () => {
      await this.load();
      const account = this.accounts.find((item) => item.email === email.toLowerCase());
      if (!account)
        return false;
      this.accounts = this.accounts.filter((item) => item !== account);
      this.tokens.delete(account.email);
      await this.save();
      await this.revoke(account.refreshToken);
      return true;
    });
  }
  async request(email, method, url, body) {
    if (!API_ORIGINS.some((origin) => url.startsWith(origin)))
      throw new GoogleError(400, "That is not a Google API the Planner uses");
    const send = async (token) => {
      try {
        return await this.fetcher(url, {
          method,
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...body === undefined ? {} : { "Content-Type": "application/json" } },
          ...body === undefined ? {} : { body: JSON.stringify(body) },
          signal: AbortSignal.timeout(TIMEOUT_MS3)
        });
      } catch (error) {
        throw new GoogleError(502, `Could not reach Google: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    let response = await send(await this.accessToken(email));
    if (response.status === 401) {
      this.tokens.delete(email.toLowerCase());
      response = await send(await this.accessToken(email));
    }
    const text = await response.text();
    if (response.status >= 400) {
      const message = googleMessage(text, response.status);
      if (response.status === 403 && /insufficient|scope/i.test(message))
        throw new GoogleError(403, `${email} has not allowed this; connect it again with that feature turned on`);
      throw new GoogleError(googleStatus(response.status), message);
    }
    return text ? JSON.parse(text) : null;
  }
  async callback(id, url) {
    const signIn = this.signIns.get(id);
    if (!signIn || signIn.result.status !== "pending")
      return page("Planner", "This sign-in is already over. You can close this tab.");
    if (url.searchParams.get("state") !== signIn.state) {
      return page("Planner", "This page does not belong to the sign-in the Planner is waiting for.");
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error || !code) {
      this.endSignIn(id, { status: "failed", message: error === "access_denied" ? "Access was not allowed" : `Google said: ${error ?? "no code"}` });
      return page("Not connected", "Google did not let the Planner in. You can close this tab and try again.");
    }
    try {
      const account = await this.exchange(code, signIn);
      this.endSignIn(id, { status: "connected", email: account.email, features: featuresOf(account.scopes) });
      return page("Connected", `The Planner can now use ${account.email}. You can close this tab.`);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      this.endSignIn(id, { status: "failed", message });
      return page("Not connected", `${message.replace(/[<>&]/g, "")}. You can close this tab.`);
    }
  }
  async exchange(code, signIn) {
    const client = this.client;
    if (!client)
      throw new GoogleError(400, "The OAuth client was removed");
    const answer = await this.token({ grant_type: "authorization_code", code, code_verifier: signIn.verifier, redirect_uri: signIn.redirectUri, client_id: client.id, client_secret: client.secret });
    if (!answer.refresh_token)
      throw new GoogleError(400, "Google sent no refresh token; remove the Planner at myaccount.google.com/permissions and connect again");
    const email = emailFromIdToken(answer.id_token);
    if (!email)
      throw new GoogleError(400, "Google did not say which account this is (the 'email' scope was not granted)");
    const account = { email, refreshToken: answer.refresh_token, scopes: (answer.scope ?? "").split(" ").filter(Boolean), addedAt: new Date().toISOString() };
    await this.serial(async () => {
      const index = this.accounts.findIndex((item) => item.email === email);
      if (index < 0 && this.accounts.length >= MAX_ACCOUNTS)
        throw new GoogleError(400, `At most ${MAX_ACCOUNTS} Google accounts`);
      this.accounts = index < 0 ? [...this.accounts, account] : this.accounts.map((item, at) => at === index ? { ...account, addedAt: item.addedAt } : item);
      await this.save();
    });
    if (answer.access_token)
      this.tokens.set(email, { token: answer.access_token, expires: Date.now() + (answer.expires_in ?? 3600) * 1000 });
    return account;
  }
  async accessToken(rawEmail) {
    const email = rawEmail.toLowerCase();
    const cached = this.tokens.get(email);
    if (cached && cached.expires - 60000 > Date.now())
      return cached.token;
    await this.load();
    const account = this.accounts.find((item) => item.email === email);
    if (!account)
      throw new GoogleError(404, `${email} is not connected`);
    if (!this.client)
      throw new GoogleError(400, "Add the OAuth client again");
    let answer;
    try {
      answer = await this.token({ grant_type: "refresh_token", refresh_token: account.refreshToken, client_id: this.client.id, client_secret: this.client.secret });
    } catch (error) {
      if (error instanceof GoogleError && /invalid_grant|expired|revoked/i.test(error.message))
        throw new GoogleError(401, `Google no longer accepts the Planner's access to ${email}; connect it again`);
      throw error;
    }
    if (!answer.access_token)
      throw new GoogleError(502, "Google sent no access token");
    this.tokens.set(email, { token: answer.access_token, expires: Date.now() + (answer.expires_in ?? 3600) * 1000 });
    return answer.access_token;
  }
  async token(fields) {
    let response;
    try {
      response = await this.fetcher(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(fields).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS3)
      });
    } catch (error) {
      throw new GoogleError(502, `Could not reach Google: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    if (response.status >= 400)
      throw new GoogleError(response.status === 400 || response.status === 401 ? 400 : 502, googleMessage(text, response.status));
    return JSON.parse(text);
  }
  async revoke(token) {
    try {
      await this.fetcher(REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString(), signal: AbortSignal.timeout(TIMEOUT_MS3) });
    } catch (error) {
      this.log(`could not revoke a Google token: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  endSignIn(id, result) {
    const signIn = this.signIns.get(id);
    if (!signIn || signIn.result.status !== "pending")
      return;
    signIn.result = result;
    signIn.close();
    setTimeout(() => this.signIns.delete(id), 5 * 60000).unref?.();
  }
  expireSignIns() {
    for (const [id, signIn] of this.signIns)
      if (signIn.expires < Date.now())
        this.endSignIn(id, { status: "failed", message: "The sign-in took too long; start it again" });
  }
  load() {
    this.loaded ??= (async () => {
      let text;
      try {
        text = await readFile2(this.file, "utf8");
      } catch (error) {
        if (error.code === "ENOENT")
          return;
        throw error;
      }
      try {
        const parsed = JSON.parse(text);
        const client = parsed.client;
        this.client = client && typeof client.id === "string" && typeof client.secret === "string" ? { id: client.id, secret: client.secret } : null;
        this.accounts = Array.isArray(parsed.accounts) ? parsed.accounts.filter(isStoredAccount) : [];
      } catch {
        this.log(`${this.file} is not readable JSON; Google needs to be connected again`);
      }
    })();
    return this.loaded;
  }
  async save() {
    await mkdir2(dirname2(this.file), { recursive: true, mode: 448 });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile2(temp, `${JSON.stringify({ version: 1, client: this.client, accounts: this.accounts }, null, 2)}
`, { mode: 384 });
    await chmod2(temp, 384);
    await rename2(temp, this.file);
  }
  serial(work) {
    const next = this.writes.then(work, work);
    this.writes = next.catch(() => {});
    return next;
  }
}

// src/domain/google.ts
var PLANNER_BLOCK_KEY = "plannerBlockId";
var RESPONSES = ["needsAction", "declined", "tentative", "accepted"];
var EVENT_COLORS = {
  "1": { name: "Lavender", color: "#7986cb" },
  "2": { name: "Sage", color: "#33b679" },
  "3": { name: "Grape", color: "#8e24aa" },
  "4": { name: "Flamingo", color: "#e67c73" },
  "5": { name: "Banana", color: "#f6bf26" },
  "6": { name: "Tangerine", color: "#f4511e" },
  "7": { name: "Peacock", color: "#039be5" },
  "8": { name: "Graphite", color: "#616161" },
  "9": { name: "Blueberry", color: "#3f51b5" },
  "10": { name: "Basil", color: "#0b8043" },
  "11": { name: "Tomato", color: "#d50000" }
};
var meetLink = (event) => {
  const video = event.conferenceData?.entryPoints?.find((point) => point.entryPointType === "video" && point.uri && /^https:\/\//.test(point.uri))?.uri;
  return video ?? (event.hangoutLink && /^https:\/\//.test(event.hangoutLink) ? event.hangoutLink : null);
};
var writableRole = (role) => role === "owner" || role === "writer";
var eventEditable = (event, accessRole) => {
  if (!writableRole(accessRole) || event.locked || event.privateCopy)
    return false;
  if (event.eventType && !["default", "focusTime", "outOfOffice"].includes(event.eventType))
    return false;
  return !event.organizer || event.organizer.self === true || Boolean(event.guestsCanModify);
};
var eventRef = (event, source) => {
  const self = event.attendees?.find((attendee) => attendee.self);
  return {
    account: source.account,
    calendarId: source.calendarId,
    eventId: event.id,
    recurringEventId: event.recurringEventId ?? null,
    editable: eventEditable(event, source.accessRole),
    response: self && !self.organizer && RESPONSES.includes(self.responseStatus ?? "") ? self.responseStatus : null,
    guests: (event.attendees ?? []).some((attendee) => !attendee.self && !attendee.resource),
    color: event.colorId ? EVENT_COLORS[event.colorId]?.color ?? null : null,
    htmlLink: event.htmlLink && /^https:\/\//.test(event.htmlLink) ? event.htmlLink : "",
    meet: meetLink(event)
  };
};
var googleEvent = (event, calendarId, zone, source) => {
  if (!event.id || event.status === "cancelled")
    return null;
  if (event.extendedProperties?.private?.[PLANNER_BLOCK_KEY])
    return null;
  const declined = Boolean(event.attendees?.some((attendee) => attendee.self && attendee.responseStatus === "declined"));
  const base = { id: `${calendarId}:${event.id}`, calendarId, title: event.summary?.trim() || "(No title)", location: event.location ?? "", ...source ? { google: eventRef(event, source) } : {} };
  if (event.start?.date && isDateKey(event.start.date)) {
    const endDate = event.end?.date && isDateKey(event.end.date) && event.end.date > event.start.date ? event.end.date : null;
    const start = instantAt(event.start.date, 0, zone);
    const end = endDate ? instantAt(endDate, 0, zone) : new Date(Date.parse(start) + 86400000).toISOString();
    return { ...base, start, end, allDay: true, busy: false };
  }
  const startMs = Date.parse(event.start?.dateTime ?? "");
  const endMs = Date.parse(event.end?.dateTime ?? "");
  if (Number.isNaN(startMs))
    return null;
  return { ...base, start: new Date(startMs).toISOString(), end: new Date(Number.isNaN(endMs) ? startMs : Math.max(endMs, startMs)).toISOString(), allDay: false, busy: event.transparency !== "transparent" && !declined };
};
var eventDetail = (event, source, seriesRecurrence) => {
  const ref = eventRef(event, source);
  const conference = meetLink(event);
  const visibility = event.visibility === "public" || event.visibility === "private" || event.visibility === "confidential" ? event.visibility : "default";
  return {
    account: source.account,
    calendarId: source.calendarId,
    id: event.id,
    recurringEventId: event.recurringEventId ?? null,
    title: event.summary?.trim() || "(No title)",
    description: event.description ?? "",
    location: event.location ?? "",
    start: event.start ?? {},
    end: event.end ?? {},
    allDay: Boolean(event.start?.date),
    recurrence: [...event.recurrence ?? seriesRecurrence ?? []],
    attendees: (event.attendees ?? []).flatMap((attendee) => attendee.email ? [{
      email: attendee.email,
      name: attendee.displayName?.trim() || attendee.email,
      response: RESPONSES.includes(attendee.responseStatus ?? "") ? attendee.responseStatus : "needsAction",
      self: Boolean(attendee.self),
      organizer: Boolean(attendee.organizer),
      optional: Boolean(attendee.optional),
      resource: Boolean(attendee.resource)
    }] : []),
    attendeesOmitted: Boolean(event.attendeesOmitted),
    organizer: event.organizer?.email ? { email: event.organizer.email, name: event.organizer.displayName?.trim() || event.organizer.email, self: Boolean(event.organizer.self) } : null,
    meet: conference ? { url: conference, label: event.conferenceData?.conferenceSolution?.name ?? "Google Meet" } : null,
    reminders: {
      useDefault: event.reminders?.useDefault !== false,
      overrides: (event.reminders?.overrides ?? []).flatMap((item) => typeof item.minutes === "number" ? [{ method: item.method === "email" ? "email" : "popup", minutes: item.minutes }] : [])
    },
    colorId: event.colorId ?? null,
    transparency: event.transparency === "transparent" ? "transparent" : "opaque",
    visibility,
    htmlLink: ref.htmlLink,
    editable: ref.editable,
    response: ref.response,
    eventType: event.eventType ?? "default"
  };
};
var plannerBlockOf = (event) => event.extendedProperties?.private?.[PLANNER_BLOCK_KEY] ?? null;
var GOOGLE_TASKS_CALENDAR = "google-tasks";
var dueTaskEvent = (item, zone) => ({
  id: `gtask:${item.listId}:${item.id}`,
  calendarId: GOOGLE_TASKS_CALENDAR,
  title: item.title,
  location: "",
  start: instantAt(item.due, 0, zone),
  end: instantAt(addDays(item.due, 1), 0, zone),
  allDay: true,
  busy: false,
  googleTask: item
});
var TASK_GONE = "This task is no longer in Google Tasks";
var gmailUrl = (account, threadId) => `https://mail.google.com/mail/u/${encodeURIComponent(account)}/#all/${encodeURIComponent(threadId)}`;

// src/domain/gevents.ts
var EDIT_SCOPES = ["this", "following", "all"];
var isRecord3 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var isText = (value, max) => typeof value === "string" && value.length <= max;
var isEmailAddress = (value) => typeof value === "string" && value.length <= 254 && /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(value);
var timeKind = (time) => {
  if (!isRecord3(time))
    return null;
  if (time.date !== undefined)
    return isDateKey(time.date) && time.dateTime === undefined ? "date" : null;
  if (typeof time.dateTime !== "string" || Number.isNaN(Date.parse(time.dateTime)))
    return null;
  if (time.timeZone !== undefined && !isValidTimeZone(time.timeZone))
    return null;
  return "dateTime";
};
var startMs = (time) => time.date ? Date.parse(`${time.date}T00:00:00Z`) : Date.parse(time.dateTime ?? "");
var checkEventInput = (input, creating) => {
  if (!isRecord3(input))
    return "event must be an object";
  const allowed = new Set(["summary", "description", "location", "start", "end", "recurrence", "attendees", "reminders", "colorId", "transparency", "visibility", "meet"]);
  for (const key of Object.keys(input))
    if (!allowed.has(key))
      return `unknown event field ${key}`;
  if (input.summary !== undefined && !isText(input.summary, 1024))
    return "the title is too long";
  if (input.description !== undefined && !isText(input.description, 8000))
    return "the description is too long";
  if (input.location !== undefined && !isText(input.location, 1024))
    return "the location is too long";
  if (creating && (input.start === undefined || input.end === undefined))
    return "a new event needs a start and an end";
  if (input.start === undefined !== (input.end === undefined))
    return "start and end change together";
  if (input.start !== undefined) {
    const kinds = [timeKind(input.start), timeKind(input.end)];
    if (!kinds[0] || kinds[0] !== kinds[1])
      return "start and end must both be days, or both be times";
    if (startMs(input.end) <= startMs(input.start))
      return "the event must end after it starts";
  }
  if (input.recurrence !== undefined) {
    if (!Array.isArray(input.recurrence) || input.recurrence.length > 10)
      return "recurrence must be at most 10 lines";
    if (!input.recurrence.every((line) => isText(line, 1000) && /^(RRULE|EXRULE|RDATE|EXDATE)[:;]/i.test(line)))
      return "recurrence lines must be RRULE, RDATE or EXDATE";
  }
  if (input.attendees !== undefined) {
    if (!Array.isArray(input.attendees) || input.attendees.length > 200)
      return "at most 200 guests";
    if (!input.attendees.every((guest) => isRecord3(guest) && isEmailAddress(guest.email) && (guest.optional === undefined || typeof guest.optional === "boolean")))
      return "a guest is not an email address";
  }
  if (input.reminders !== undefined) {
    const reminders = input.reminders;
    if (!isRecord3(reminders) || typeof reminders.useDefault !== "boolean")
      return "reminders must say whether to use the calendar default";
    const overrides = reminders.overrides ?? [];
    if (!Array.isArray(overrides) || overrides.length > 5)
      return "at most 5 notifications";
    if (!overrides.every((item) => isRecord3(item) && (item.method === "popup" || item.method === "email") && Number.isInteger(item.minutes) && item.minutes >= 0 && item.minutes <= 40320))
      return "a notification must be 0 to 40320 minutes before";
  }
  if (input.colorId !== undefined && input.colorId !== null && !(typeof input.colorId === "string" && EVENT_COLORS[input.colorId]))
    return "unknown event color";
  if (input.transparency !== undefined && input.transparency !== "opaque" && input.transparency !== "transparent")
    return "transparency must be opaque or transparent";
  if (input.visibility !== undefined && !["default", "public", "private"].includes(input.visibility))
    return "visibility must be default, public or private";
  if (input.meet !== undefined && typeof input.meet !== "boolean")
    return "meet must be true or false";
  return null;
};
var sameTime = (a, b) => Boolean(a && b) && (a.date ? a.date === b.date : Date.parse(a.dateTime ?? "") === Date.parse(b.dateTime ?? ""));
var eventBody = (input, existing, requestId) => {
  const body = {};
  let conference = false;
  if (input.summary !== undefined)
    body.summary = input.summary;
  if (input.description !== undefined)
    body.description = input.description;
  if (input.location !== undefined)
    body.location = input.location;
  if (input.start !== undefined)
    body.start = input.start;
  if (input.end !== undefined)
    body.end = input.end;
  if (input.recurrence !== undefined)
    body.recurrence = input.recurrence;
  if (input.attendees !== undefined) {
    const before = new Map((existing?.attendees ?? []).filter((attendee) => attendee.email).map((attendee) => [attendee.email.toLowerCase(), attendee]));
    const kept = input.attendees.map((guest) => {
      const known = before.get(guest.email.toLowerCase());
      return known ? { ...known, ...guest.optional !== undefined ? { optional: guest.optional } : {} } : { email: guest.email, ...guest.optional ? { optional: true } : {} };
    });
    const wanted = new Set(kept.map((guest) => guest.email.toLowerCase()));
    const staying = (existing?.attendees ?? []).filter((attendee) => attendee.email && !wanted.has(attendee.email.toLowerCase()) && (attendee.organizer || attendee.self || attendee.resource));
    body.attendees = [...staying, ...kept];
  }
  if (input.reminders !== undefined)
    body.reminders = input.reminders.useDefault ? { useDefault: true } : { useDefault: false, overrides: input.reminders.overrides ?? [] };
  if (input.colorId !== undefined)
    body.colorId = input.colorId;
  if (input.transparency !== undefined)
    body.transparency = input.transparency;
  if (input.visibility !== undefined)
    body.visibility = input.visibility;
  if (input.meet === true && !existing?.conferenceData && !existing?.hangoutLink) {
    body.conferenceData = { createRequest: { requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } };
    conference = true;
  } else if (input.meet === false && (existing?.conferenceData || existing?.hangoutLink)) {
    body.conferenceData = null;
    conference = true;
  }
  return { body, conference };
};
var localOf = (time, zone) => {
  if (!time)
    return null;
  if (time.date)
    return isDateKey(time.date) ? { date: time.date, minutes: 0 } : null;
  const ms = Date.parse(time.dateTime ?? "");
  return Number.isNaN(ms) ? null : zonedDateMinutes(ms, zone);
};
var seriesTimes = (instance, series, start, end, zone) => {
  const original = localOf(instance.originalStartTime ?? instance.start, zone);
  const moved = localOf(start, zone);
  const first = localOf(series.start, zone);
  if (!original || !moved || !first)
    return null;
  const days = daysBetween(original.date, moved.date);
  const firstDay = addDays(first.date, days);
  if (start.date && end.date) {
    return { start: { date: firstDay }, end: { date: addDays(firstDay, Math.max(1, daysBetween(start.date, end.date))) }, from: original.date, to: moved.date };
  }
  const length = Date.parse(end.dateTime ?? "") - Date.parse(start.dateTime ?? "");
  const zoneOf = series.start?.timeZone ?? start.timeZone ?? zone;
  const begin = instantAt(firstDay, moved.minutes, zone);
  return {
    start: { dateTime: begin, timeZone: zoneOf },
    end: { dateTime: new Date(Date.parse(begin) + length).toISOString(), timeZone: zoneOf },
    from: original.date,
    to: moved.date
  };
};
var sameLines = (a, b) => JSON.stringify([...a ?? []].sort()) === JSON.stringify([...b ?? []].sort());
var seriesCopy = (series) => {
  const copy = {};
  for (const key of ["summary", "description", "location", "colorId", "transparency", "visibility", "guestsCanModify", "guestsCanInviteOthers", "guestsCanSeeOtherGuests", "reminders", "conferenceData"]) {
    if (series[key] !== undefined)
      copy[key] = series[key];
  }
  if (series.attendees)
    copy.attendees = series.attendees.map(({ email, displayName, optional, resource, organizer, self }) => ({ email, ...displayName ? { displayName } : {}, ...optional ? { optional } : {}, ...resource ? { resource } : {}, ...organizer ? { organizer } : {}, ...self ? { self } : {} }));
  return copy;
};
var planEdit = (args) => {
  const { scope, instance, series, input, zone, requestId } = args;
  if (!instance.recurringEventId) {
    const { body, conference } = eventBody(input, instance, requestId);
    return { ops: [{ method: "PATCH", eventId: instance.id, body, conference, role: "change" }] };
  }
  if (!series)
    return { error: "The series this event belongs to is gone from Google Calendar" };
  const changesRule = input.recurrence !== undefined && !sameLines(input.recurrence, series.recurrence);
  if (scope === "this") {
    if (changesRule)
      return { error: 'One event of a series cannot repeat on its own: choose "This and following events" or "All events"' };
    const { recurrence: _drop, ...rest } = input;
    const { body, conference } = eventBody(rest, instance, requestId);
    return { ops: [{ method: "PATCH", eventId: instance.id, body, conference, role: "change" }] };
  }
  const original = instance.originalStartTime ?? instance.start;
  const first = sameTime(original, series.start);
  const start = input.start ?? instance.start;
  const end = input.end ?? instance.end;
  const timesChanged = input.start !== undefined && start && end && !(sameTime(start, instance.start) && sameTime(end, instance.end));
  const { rule, rest } = splitRecurrence(series.recurrence ?? []);
  if (scope === "all" || first) {
    const next = { ...input };
    if (timesChanged) {
      const moved = seriesTimes(instance, series, start, end, zone);
      if (!moved)
        return { error: "Google did not say when this series starts" };
      next.start = moved.start;
      next.end = moved.end;
      if (moved.from !== moved.to && !changesRule) {
        const shifted = rule ? shiftRule(rule, moved.from, moved.to) : null;
        if (!shifted)
          return { error: 'This series repeats in a way the Planner cannot move to another day: move "This event" only, or change the repeat rule in the editor' };
        next.recurrence = [formatRRule(shifted), ...rest];
      }
    } else {
      delete next.start;
      delete next.end;
    }
    const { body, conference } = eventBody(next, series, requestId);
    return { ops: [{ method: "PATCH", eventId: series.id, body, conference, role: "change" }] };
  }
  if (!rule)
    return { error: 'This series repeats in a way the Planner cannot split: change "This event" or "All events"' };
  const until = untilBefore(original ?? {});
  if (!until)
    return { error: "Google did not say when this event first was" };
  let lines;
  if (changesRule)
    lines = input.recurrence ?? [];
  else {
    let next = rule;
    if (rule.count !== null) {
      if (args.priorCount === undefined)
        return { error: "How many events come before this one is needed to split the series", needs: "priorCount" };
      const remaining = rule.count - args.priorCount;
      if (remaining < 1)
        return { error: "This series has no events from this one on" };
      next = { ...rule, count: remaining };
    }
    if (timesChanged) {
      const from = localOf(original, zone);
      const to = localOf(start, zone);
      const shifted = from && to ? shiftRule(next, from.date, to.date) : null;
      if (!shifted)
        return { error: 'This series repeats in a way the Planner cannot move to another day: move "This event" only' };
      next = shifted;
    }
    lines = [formatRRule(next), ...rest];
  }
  const copied = seriesCopy(series);
  const created = eventBody({ ...input, start, end, recurrence: lines }, copied, requestId);
  const body = { ...copied, ...created.body };
  if (body.conferenceData === null)
    delete body.conferenceData;
  const conference = created.conference || Boolean(body.conferenceData);
  return {
    ops: [
      { method: "POST", eventId: null, body, conference, role: "create" },
      { method: "PATCH", eventId: series.id, body: { recurrence: [formatRRule({ ...rule, count: null, until }), ...rest] }, role: "truncate" }
    ]
  };
};
var planDelete = (args) => {
  const { scope, instance, series } = args;
  if (!instance.recurringEventId || scope === "this")
    return { ops: [{ method: "DELETE", eventId: instance.id, role: "delete" }] };
  if (!series)
    return { error: "The series this event belongs to is gone from Google Calendar" };
  const original = instance.originalStartTime ?? instance.start;
  if (scope === "all" || sameTime(original, series.start))
    return { ops: [{ method: "DELETE", eventId: series.id, role: "delete" }] };
  const { rule, rest } = splitRecurrence(series.recurrence ?? []);
  const until = untilBefore(original ?? {});
  if (!rule || !until)
    return { error: 'This series repeats in a way the Planner cannot end early: delete "This event" or "All events"' };
  return { ops: [{ method: "PATCH", eventId: series.id, body: { recurrence: [formatRRule({ ...rule, count: null, until }), ...rest] }, role: "truncate" }] };
};
var planRsvp = (args) => {
  const target = args.scope === "all" && args.series ? args.series : args.instance;
  const attendees = target.attendees ?? [];
  if (!attendees.some((attendee) => attendee.self))
    return { error: "You are not on this event's guest list" };
  return { ops: [{ method: "PATCH", eventId: target.id, body: { attendees: attendees.map((attendee) => attendee.self ? { ...attendee, responseStatus: args.response } : attendee) }, role: "change" }] };
};

// service/googleData.ts
var CALENDAR = "https://www.googleapis.com/calendar/v3";
var TASKS = "https://tasks.googleapis.com/tasks/v1";
var GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
var EVENT_FIELDS = "accessRole,nextPageToken,items(id,status,summary,location,transparency,colorId,eventType,start,end,recurringEventId,originalStartTime,attendees(email,self,organizer,resource,responseStatus),organizer(email,self),guestsCanModify,locked,privateCopy,hangoutLink,conferenceData(entryPoints(entryPointType,uri)),extendedProperties,htmlLink)";
var LIMITS = { calendars: 10, events: 8, lists: 5, tasks: 40, due: 20 };
var MAIL_MAX = 25;
var enc = encodeURIComponent;
var mapLimited = async (items, limit, fn) => {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
};
var isGone = (error) => error instanceof GoogleError && error.status === 404;
var color = (value) => value && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : "#4285f4";
var dueDate = (due) => due && isDateKey(due.slice(0, 10)) ? due.slice(0, 10) : null;
var toTaskItem = (raw, account, listId) => {
  if (!raw.id || raw.deleted)
    return null;
  return {
    account,
    listId,
    id: raw.id,
    title: raw.title?.trim() || "(No title)",
    notes: raw.notes ?? "",
    due: dueDate(raw.due),
    completed: raw.status === "completed",
    ...raw.status === "completed" ? { completedAt: raw.completed ?? null } : {},
    parent: raw.parent ?? null,
    position: raw.position ?? "",
    url: raw.webViewLink && /^https:\/\//.test(raw.webViewLink) ? raw.webViewLink : `https://tasks.google.com/task/${enc(raw.id)}`,
    updated: raw.updated ?? ""
  };
};
var plain = (text) => text.replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code))).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
var toMailItem = (raw, account) => {
  if (!raw.id || !raw.threadId)
    return null;
  const header = (name) => raw.payload?.headers?.find((item) => item.name?.toLowerCase() === name)?.value ?? "";
  const internal = Number(raw.internalDate);
  return {
    account,
    id: raw.id,
    threadId: raw.threadId,
    subject: header("subject").trim() || "(No subject)",
    from: header("from").trim(),
    date: Number.isFinite(internal) && internal > 0 ? new Date(internal).toISOString() : "",
    snippet: plain(raw.snippet ?? ""),
    unread: Boolean(raw.labelIds?.includes("UNREAD")),
    url: gmailUrl(account, raw.threadId)
  };
};
var UNDO_MS = 10 * 60000;
var RESTORED_FIELDS = ["summary", "description", "location", "colorId", "start", "end", "recurrence", "attendees", "reminders", "transparency", "visibility", "conferenceData", "guestsCanInviteOthers", "guestsCanModify", "guestsCanSeeOtherGuests", "anyoneCanAddSelf", "source", "extendedProperties"];

class GoogleData {
  accounts;
  roles = new Map;
  deleted = new Map;
  constructor(accounts) {
    this.accounts = accounts;
  }
  async pages(account, url, limit) {
    const items = [];
    let pageToken;
    let first = null;
    for (let page = 0;page < limit; page++) {
      const data = await this.accounts.request(account, "GET", url(pageToken));
      first ??= data;
      items.push(...data?.items ?? []);
      pageToken = data?.nextPageToken;
      if (!pageToken)
        return { items, complete: true, first };
    }
    return { items, complete: false, first };
  }
  async calendars(account) {
    const { items, complete } = await this.pages(account, (token) => `${CALENDAR}/users/me/calendarList?${new URLSearchParams({ minAccessRole: "reader", maxResults: "250", ...token ? { pageToken: token } : {} })}`, LIMITS.calendars);
    if (!complete)
      throw new GoogleError(502, `${account} has more than ${LIMITS.calendars * 250} calendars; the Planner reads at most that many`);
    return items.flatMap((item) => {
      if (!item.id)
        return [];
      if (item.accessRole)
        this.roles.set(`${account}
${item.id}`, item.accessRole);
      return [{ account, id: item.id, name: item.summaryOverride ?? item.summary ?? item.id, color: color(item.backgroundColor), primary: Boolean(item.primary), writable: item.accessRole === "owner" || item.accessRole === "writer", accessRole: item.accessRole ?? "reader" }];
    });
  }
  async events(account, calendarId, timeMin, timeMax, zone, subscriptionId) {
    const events = [];
    const sessions = [];
    const { items, complete, first } = await this.pages(account, (token) => `${CALENDAR}/calendars/${enc(calendarId)}/events?${new URLSearchParams({ singleEvents: "true", orderBy: "startTime", timeMin, timeMax, maxResults: "2500", fields: EVENT_FIELDS, ...token ? { pageToken: token } : {} })}`, LIMITS.events);
    if (!complete)
      throw new GoogleError(502, `More than ${LIMITS.events * 2500} events in this range; the Planner reads at most that many`);
    const accessRole = typeof first?.accessRole === "string" ? first.accessRole : undefined;
    if (accessRole)
      this.roles.set(`${account}
${calendarId}`, accessRole);
    for (const raw of items) {
      const blockId = plannerBlockOf(raw);
      if (blockId && raw.id && raw.status !== "cancelled" && raw.start?.dateTime && raw.end?.dateTime) {
        sessions.push({ blockId, eventId: raw.id, start: new Date(raw.start.dateTime).toISOString(), end: new Date(raw.end.dateTime).toISOString() });
      }
      const event = googleEvent(raw, subscriptionId, zone, { account, calendarId, accessRole });
      if (event)
        events.push(event);
    }
    return { events, sessions };
  }
  async searchEvents(account, calendarId, query, timeMin, timeMax, zone, subscriptionId) {
    const { items, complete, first } = await this.pages(account, (token) => `${CALENDAR}/calendars/${enc(calendarId)}/events?${new URLSearchParams({ q: query, singleEvents: "true", orderBy: "startTime", timeMin, timeMax, maxResults: "250", fields: EVENT_FIELDS, ...token ? { pageToken: token } : {} })}`, 2);
    const accessRole = typeof first?.accessRole === "string" ? first.accessRole : this.roles.get(`${account}
${calendarId}`);
    const events = [];
    for (const raw of items) {
      const event = googleEvent(raw, subscriptionId, zone, { account, calendarId, accessRole });
      if (event)
        events.push(event);
    }
    return { events, more: !complete };
  }
  async putTimebox(account, calendarId, timebox, eventId) {
    const body = {
      summary: timebox.title,
      start: { dateTime: timebox.start },
      end: { dateTime: timebox.end },
      transparency: "opaque",
      extendedProperties: { private: { [PLANNER_BLOCK_KEY]: timebox.blockId, plannerTaskId: timebox.taskId } }
    };
    const base = `${CALENDAR}/calendars/${enc(calendarId)}/events`;
    const data = eventId ? await this.accounts.request(account, "PATCH", `${base}/${enc(eventId)}`, body) : await this.accounts.request(account, "POST", base, { ...body, reminders: { useDefault: false } });
    if (!data?.id)
      throw new Error("Google did not return the event");
    return data.id;
  }
  async deleteTimebox(account, calendarId, eventId) {
    try {
      await this.accounts.request(account, "DELETE", `${CALENDAR}/calendars/${enc(calendarId)}/events/${enc(eventId)}`);
    } catch (error) {
      if (!isGone(error))
        throw error;
    }
  }
  async event(account, calendarId, eventId) {
    try {
      const raw = await this.accounts.request(account, "GET", `${CALENDAR}/calendars/${enc(calendarId)}/events/${enc(eventId)}`);
      return raw && raw.status !== "cancelled" ? raw : null;
    } catch (error) {
      if (isGone(error))
        return null;
      throw error;
    }
  }
  async mustEvent(account, calendarId, eventId) {
    const raw = await this.event(account, calendarId, eventId);
    if (!raw?.id)
      throw new GoogleError(404, "This event is no longer in Google Calendar");
    return raw;
  }
  async role(account, calendarId) {
    const key = `${account}
${calendarId}`;
    if (!this.roles.has(key)) {
      try {
        await this.calendars(account);
      } catch {}
    }
    return this.roles.get(key);
  }
  async eventDetail(account, calendarId, eventId) {
    const raw = await this.mustEvent(account, calendarId, eventId);
    let rule = null;
    if (raw.recurringEventId)
      rule = (await this.event(account, calendarId, raw.recurringEventId))?.recurrence ?? [];
    return eventDetail(raw, { account, calendarId, accessRole: await this.role(account, calendarId) }, rule);
  }
  async insertEvent(account, calendarId, input, sendUpdates) {
    const problem = checkEventInput(input, true);
    if (problem)
      throw new GoogleError(400, problem);
    const { body, conference } = eventBody(input, null, newId());
    const query = new URLSearchParams({ sendUpdates, ...conference ? { conferenceDataVersion: "1" } : {} });
    const raw = await this.accounts.request(account, "POST", `${CALENDAR}/calendars/${enc(calendarId)}/events?${query}`, body);
    if (!raw?.id)
      throw new GoogleError(502, "Google did not return the event");
    return eventDetail(raw, { account, calendarId, accessRole: await this.role(account, calendarId) }, null);
  }
  async priorCount(account, calendarId, series, instance) {
    const before = instance.originalStartTime?.dateTime ?? (instance.originalStartTime?.date ? `${instance.originalStartTime.date}T00:00:00Z` : null);
    const from = series.start?.dateTime ?? (series.start?.date ? `${series.start.date}T00:00:00Z` : null);
    if (!before || !from)
      throw new GoogleError(502, "Google did not say when this series starts");
    const { items, complete } = await this.pages(account, (token) => `${CALENDAR}/calendars/${enc(calendarId)}/events/${enc(series.id)}/instances?${new URLSearchParams({ timeMin: new Date(Date.parse(from) - 1000).toISOString(), timeMax: new Date(Date.parse(before)).toISOString(), showDeleted: "true", maxResults: "2500", fields: "nextPageToken,items(id,originalStartTime)", ...token ? { pageToken: token } : {} })}`, LIMITS.events);
    if (!complete)
      throw new GoogleError(502, "This series is too long to split here");
    return items.filter((item) => Date.parse(item.originalStartTime?.dateTime ?? `${item.originalStartTime?.date ?? ""}T00:00:00Z`) < Date.parse(before)).length;
  }
  async run(account, calendarId, plan, sendUpdates) {
    if ("error" in plan)
      throw new GoogleError(400, plan.error);
    const base = `${CALENDAR}/calendars/${enc(calendarId)}/events`;
    const created = [];
    for (const op of plan.ops) {
      const query = new URLSearchParams({ sendUpdates, ...op.conference ? { conferenceDataVersion: "1" } : {} });
      try {
        if (op.method === "POST") {
          const raw = await this.accounts.request(account, "POST", `${base}?${query}`, op.body);
          if (!raw?.id)
            throw new GoogleError(502, "Google did not return the new series");
          created.push(raw.id);
        } else if (op.method === "PATCH")
          await this.accounts.request(account, "PATCH", `${base}/${enc(op.eventId)}?${query}`, op.body);
        else {
          try {
            await this.accounts.request(account, "DELETE", `${base}/${enc(op.eventId)}?${query}`);
          } catch (error) {
            if (!isGone(error))
              throw error;
          }
        }
      } catch (error) {
        for (const id of created)
          await this.accounts.request(account, "DELETE", `${base}/${enc(id)}?sendUpdates=none`).catch(() => {});
        throw error;
      }
    }
    return plan.ops.length;
  }
  async withSeries(account, calendarId, eventId) {
    const instance = await this.mustEvent(account, calendarId, eventId);
    const series = instance.recurringEventId ? await this.event(account, calendarId, instance.recurringEventId) : null;
    return { instance, series };
  }
  async updateEvent(account, calendarId, eventId, input, scope, sendUpdates, zone) {
    const problem = checkEventInput(input, false);
    if (problem)
      throw new GoogleError(400, problem);
    const { instance, series } = await this.withSeries(account, calendarId, eventId);
    const requestId = newId();
    let plan = planEdit({ scope, instance, series, input, zone, requestId });
    if ("needs" in plan && plan.needs === "priorCount" && series)
      plan = planEdit({ scope, instance, series, input, zone, requestId, priorCount: await this.priorCount(account, calendarId, series, instance) });
    return this.run(account, calendarId, plan, sendUpdates);
  }
  async deleteEvent(account, calendarId, eventId, scope, sendUpdates) {
    let found;
    try {
      found = await this.withSeries(account, calendarId, eventId);
    } catch (error) {
      if (isGone(error))
        return { requests: 0, undo: null };
      throw error;
    }
    const requests = await this.run(account, calendarId, planDelete({ scope, ...found }), sendUpdates);
    if (found.instance.recurringEventId && scope !== "this")
      return { requests, undo: null };
    const now = Date.now();
    for (const [token, entry] of this.deleted)
      if (now - entry.at > UNDO_MS)
        this.deleted.delete(token);
    const undo = newId();
    this.deleted.set(undo, { account, calendarId, resource: found.instance, sendUpdates, at: now });
    return { requests, undo };
  }
  async restoreEvent(token) {
    const entry = this.deleted.get(token);
    this.deleted.delete(token);
    if (!entry || Date.now() - entry.at > UNDO_MS)
      throw new GoogleError(410, "This deletion can no longer be undone");
    const { account, calendarId, resource, sendUpdates } = entry;
    const base = `${CALENDAR}/calendars/${enc(calendarId)}/events`;
    if (resource.recurringEventId) {
      await this.accounts.request(account, "PATCH", `${base}/${enc(resource.id)}?${new URLSearchParams({ sendUpdates })}`, { status: "confirmed" });
      return;
    }
    const body = {};
    for (const field of RESTORED_FIELDS)
      if (resource[field] !== undefined)
        body[field] = resource[field];
    const query = new URLSearchParams({ sendUpdates, ...body.conferenceData ? { conferenceDataVersion: "1" } : {} });
    try {
      await this.accounts.request(account, "PUT", `${base}/${enc(resource.id)}?${query}`, { ...body, status: "confirmed" });
    } catch (error) {
      if (!(error instanceof GoogleError) || error.status < 400 || error.status >= 500)
        throw error;
      await this.accounts.request(account, "POST", `${base}?${query}`, body);
    }
  }
  async respond(account, calendarId, eventId, response, scope) {
    const found = await this.withSeries(account, calendarId, eventId);
    return this.run(account, calendarId, planRsvp({ scope, response, ...found }), "all");
  }
  async moveEvent(account, calendarId, eventId, destination, sendUpdates) {
    const instance = await this.mustEvent(account, calendarId, eventId);
    const target = instance.recurringEventId ?? instance.id;
    const raw = await this.accounts.request(account, "POST", `${CALENDAR}/calendars/${enc(calendarId)}/events/${enc(target)}/move?${new URLSearchParams({ destination, sendUpdates })}`);
    if (!raw?.id)
      throw new GoogleError(502, "Google did not return the event");
    return eventDetail(raw, { account, calendarId: destination, accessRole: await this.role(account, destination) }, raw.recurrence ?? null);
  }
  async taskLists(account) {
    const [{ items, complete }, fallback] = await Promise.all([
      this.pages(account, (token) => `${TASKS}/users/@me/lists?${new URLSearchParams({ maxResults: "1000", ...token ? { pageToken: token } : {} })}`, LIMITS.lists),
      this.accounts.request(account, "GET", `${TASKS}/users/@me/lists/%40default`).catch(() => null)
    ]);
    if (!complete)
      throw new GoogleError(502, `${account} has more than ${LIMITS.lists * 1000} task lists; the Planner reads at most that many`);
    return items.flatMap((item) => item.id ? [{ account, id: item.id, title: item.title?.trim() || "Tasks", isDefault: item.id === fallback?.id }] : []);
  }
  async createTaskList(account, title) {
    const raw = await this.accounts.request(account, "POST", `${TASKS}/users/@me/lists`, { title });
    if (!raw?.id)
      throw new GoogleError(502, "Google did not return the list");
    return { account, id: raw.id, title: raw.title?.trim() || title, isDefault: false };
  }
  async renameTaskList(account, listId, title) {
    const raw = await this.accounts.request(account, "PATCH", `${TASKS}/users/@me/lists/${enc(listId)}`, { title });
    return { account, id: listId, title: raw?.title?.trim() || title };
  }
  async deleteTaskList(account, listId) {
    try {
      await this.accounts.request(account, "DELETE", `${TASKS}/users/@me/lists/${enc(listId)}`);
    } catch (error) {
      if (!isGone(error))
        throw error;
    }
  }
  async tasks(account, listId) {
    const { items, complete } = await this.pages(account, (token) => `${TASKS}/lists/${enc(listId)}/tasks?${new URLSearchParams({ showCompleted: "false", showHidden: "false", maxResults: "100", ...token ? { pageToken: token } : {} })}`, LIMITS.tasks);
    if (!complete)
      throw new GoogleError(502, `This list has more than ${LIMITS.tasks * 100} open tasks; the Planner reads at most that many`);
    return items.map((raw) => toTaskItem(raw, account, listId)).filter((item) => Boolean(item)).sort((a, b) => a.position.localeCompare(b.position));
  }
  async allTasks(account, listId) {
    const { items, complete } = await this.pages(account, (token) => `${TASKS}/lists/${enc(listId)}/tasks?${new URLSearchParams({ showCompleted: "true", showHidden: "true", maxResults: "100", ...token ? { pageToken: token } : {} })}`, LIMITS.tasks);
    const tasks = items.map((raw) => toTaskItem(raw, account, listId)).filter((item) => Boolean(item));
    return { tasks: tasks.sort((a, b) => a.position.localeCompare(b.position)), complete };
  }
  async dueTasks(account, from, to) {
    const lists = await this.taskLists(account);
    const range = { showCompleted: "true", showHidden: "true", maxResults: "100", dueMin: `${from}T00:00:00.000Z`, dueMax: `${to}T23:59:59.999Z` };
    const perList = await mapLimited(lists, 4, async (list) => {
      const { items, complete } = await this.pages(account, (token) => `${TASKS}/lists/${enc(list.id)}/tasks?${new URLSearchParams({ ...range, ...token ? { pageToken: token } : {} })}`, LIMITS.due);
      if (!complete)
        throw new GoogleError(502, `"${list.title}" has more than ${LIMITS.due * 100} tasks due in these days; the Planner reads at most that many`);
      return items.map((raw) => toTaskItem(raw, account, list.id)).filter((item) => Boolean(item && item.due && item.due >= from && item.due <= to));
    });
    return perList.flat();
  }
  async tasksById(account, listId, ids) {
    const found = await mapLimited(ids, 5, async (id) => {
      try {
        const raw = await this.accounts.request(account, "GET", `${TASKS}/lists/${enc(listId)}/tasks/${enc(id)}`);
        return raw ? toTaskItem(raw, account, listId) : null;
      } catch (error) {
        if (isGone(error))
          return null;
        throw error;
      }
    });
    return found.filter((item) => Boolean(item));
  }
  async locateTasks(account, ids, except) {
    const wanted = new Set(ids);
    if (!wanted.size)
      return [];
    const lists = (await this.taskLists(account)).filter((list) => list.id !== except);
    const read = await mapLimited(lists, 4, (list) => this.allTasks(account, list.id));
    return read.flatMap((list) => list.tasks.filter((task) => wanted.has(task.id)));
  }
  async linkedTasks(account, listId, ids) {
    const here = await this.tasksById(account, listId, ids);
    const gone = ids.filter((id) => !here.some((item) => item.id === id));
    const moved = await this.locateTasks(account, gone, listId);
    return { tasks: [...here, ...moved], missing: gone.filter((id) => !moved.some((item) => item.id === id)) };
  }
  async updateTask(account, listId, id, patch) {
    const body = {};
    if (patch.completed !== undefined)
      Object.assign(body, patch.completed ? { status: "completed" } : { status: "needsAction", completed: null });
    if (patch.due !== undefined)
      body.due = patch.due ? `${patch.due}T00:00:00.000Z` : null;
    if (patch.title !== undefined)
      body.title = patch.title;
    if (patch.notes !== undefined)
      body.notes = patch.notes;
    const write = async (list) => {
      const raw = await this.accounts.request(account, "PATCH", `${TASKS}/lists/${enc(list)}/tasks/${enc(id)}`, body);
      return raw ? toTaskItem(raw, account, list) : null;
    };
    try {
      return await write(listId);
    } catch (error) {
      if (!isGone(error))
        throw error;
      const [moved] = await this.locateTasks(account, [id], listId);
      if (!moved)
        throw new GoogleError(404, TASK_GONE);
      return write(moved.listId);
    }
  }
  async createTask(account, listId, task) {
    const query = new URLSearchParams({ ...task.parent ? { parent: task.parent } : {}, ...task.previous ? { previous: task.previous } : {} });
    const raw = await this.accounts.request(account, "POST", `${TASKS}/lists/${enc(listId)}/tasks${query.size ? `?${query}` : ""}`, {
      title: task.title,
      ...task.notes ? { notes: task.notes } : {},
      ...task.due ? { due: `${task.due}T00:00:00.000Z` } : {}
    });
    return raw ? toTaskItem(raw, account, listId) : null;
  }
  async deleteTask(account, listId, id) {
    try {
      await this.accounts.request(account, "DELETE", `${TASKS}/lists/${enc(listId)}/tasks/${enc(id)}`);
    } catch (error) {
      if (!isGone(error))
        throw error;
    }
  }
  async moveTask(account, listId, id, target) {
    const query = new URLSearchParams({
      ...target.parent ? { parent: target.parent } : {},
      ...target.previous ? { previous: target.previous } : {},
      ...target.destination && target.destination !== listId ? { destinationTasklist: target.destination } : {}
    });
    const raw = await this.accounts.request(account, "POST", `${TASKS}/lists/${enc(listId)}/tasks/${enc(id)}/move${query.size ? `?${query}` : ""}`);
    return raw ? toTaskItem(raw, account, target.destination ?? listId) : null;
  }
  async mail(account, query, pageToken) {
    const list = await this.accounts.request(account, "GET", `${GMAIL}/messages?${new URLSearchParams({ q: query, maxResults: String(MAIL_MAX), ...pageToken ? { pageToken } : {} })}`);
    const ids = (list?.messages ?? []).flatMap((message) => message.id ? [message.id] : []);
    const metadata = "format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date";
    const messages = await mapLimited(ids, 5, (id) => this.accounts.request(account, "GET", `${GMAIL}/messages/${enc(id)}?${metadata}`));
    return {
      messages: messages.map((raw) => raw ? toMailItem(raw, account) : null).filter((item) => Boolean(item)).sort((a, b) => b.date.localeCompare(a.date)),
      nextPageToken: list?.nextPageToken ?? null
    };
  }
}

// service/googleTimeboxes.ts
var calendarKey = (account, calendarId) => `${account}
${calendarId}`;
var messageOf = (error) => error instanceof Error ? error.message : String(error);
var isGone2 = (error) => error instanceof GoogleError && error.status === 404;
var READ_DEADLINE_MS = 14000;
var SLACK_MS = 1e4;
var MAX_LOOKUPS = 10;
var withDeadline = (work, ms, what) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${what} took too long to answer`)), ms);
  work.then((value) => {
    clearTimeout(timer);
    resolve(value);
  }, (error) => {
    clearTimeout(timer);
    reject(error);
  });
});

class GoogleCalendars {
  data;
  ttlMs;
  cache = new Map;
  constructor(data, ttlMs = 90000) {
    this.data = data;
    this.ttlMs = ttlMs;
  }
  async read(subscriptions, alsoRead, timeMin, timeMax, zone, refresh) {
    const targets = new Map;
    for (const subscription of subscriptions) {
      if (!subscription.visible || !subscription.google)
        continue;
      const key = calendarKey(subscription.google.account, subscription.google.calendarId);
      if (!targets.has(key))
        targets.set(key, { ...subscription.google, subscriptionId: subscription.id });
    }
    for (const extra of alsoRead) {
      const key = calendarKey(extra.account, extra.calendarId);
      if (!targets.has(key))
        targets.set(key, { ...extra, subscriptionId: null });
    }
    const events = [];
    const errors = [];
    const reads = new Map;
    await Promise.all([...targets].map(async ([key, target]) => {
      const cacheKey = `${key}
${target.subscriptionId ?? ""}
${timeMin}
${timeMax}
${zone}`;
      let hit = this.cache.get(cacheKey);
      if (!hit || refresh || Date.now() - hit.at > this.ttlMs) {
        const at = Date.now();
        try {
          const read = await withDeadline(this.data.events(target.account, target.calendarId, timeMin, timeMax, zone, target.subscriptionId ?? key), READ_DEADLINE_MS, "Google Calendar");
          hit = { at, ...read };
          this.cache.set(cacheKey, hit);
        } catch (error) {
          if (target.subscriptionId)
            errors.push({ calendarId: target.subscriptionId, message: messageOf(error) });
          return;
        }
      }
      reads.set(key, { sessions: hit.sessions, readAt: hit.at });
      if (target.subscriptionId)
        events.push(...hit.events);
    }));
    return { events, errors, reads };
  }
  forget() {
    this.cache.clear();
  }
}

class GoogleDueTasks {
  data;
  ttlMs;
  cache = new Map;
  writes = 0;
  constructor(data, ttlMs = 90000) {
    this.data = data;
    this.ttlMs = ttlMs;
  }
  async byIds(groups, refresh) {
    const items = [];
    const errors = [];
    await Promise.all(groups.map(async (group) => {
      const key = `ids
${group.account}
${group.listId}
${[...group.ids].sort().join(",")}`;
      let hit = this.cache.get(key);
      if (!hit || refresh || Date.now() - hit.at > this.ttlMs) {
        try {
          const before = this.writes;
          hit = { at: Date.now(), items: await withDeadline(this.data.tasksById(group.account, group.listId, group.ids), READ_DEADLINE_MS, "Google Tasks") };
          if (this.writes === before)
            this.cache.set(key, hit);
        } catch (error) {
          errors.push(`${group.account}: ${messageOf(error)}`);
          return;
        }
      }
      items.push(...hit.items);
    }));
    return { items, errors };
  }
  async read(accounts, from, to, refresh) {
    const items = [];
    const errors = [];
    await Promise.all(accounts.map(async (account) => {
      const key = `${account}
${from}
${to}`;
      let hit = this.cache.get(key);
      if (!hit || refresh || Date.now() - hit.at > this.ttlMs) {
        try {
          const before = this.writes;
          hit = { at: Date.now(), items: await withDeadline(this.data.dueTasks(account, from, to), READ_DEADLINE_MS, "Google Tasks") };
          if (this.writes === before)
            this.cache.set(key, hit);
        } catch (error) {
          errors.push(`${account}: ${messageOf(error)}`);
          return;
        }
      }
      items.push(...hit.items);
    }));
    return { items, errors };
  }
  forget() {
    this.cache.clear();
    this.writes++;
  }
}

class GoogleTimeboxes {
  planner;
  data;
  options;
  queues = new Map;
  written = new Map;
  created = new Map;
  internal = false;
  lastError = null;
  constructor(planner, data, options = {}) {
    this.planner = planner;
    this.data = data;
    this.options = options;
    planner.onPersist((_events, before, after) => {
      if (!this.internal)
        this.observe(before, after);
    });
  }
  async settled() {
    while (this.queues.size)
      await Promise.all([...this.queues.values()]);
  }
  calendarsFor(state, timeMin, timeMax) {
    const found = new Map;
    const target = state.settings.googleTimebox;
    if (target)
      found.set(calendarKey(target.account, target.calendarId), target);
    for (const block of Object.values(state.blocks)) {
      if (!block.google || block.start < timeMin || block.start >= timeMax)
        continue;
      found.set(calendarKey(block.google.account, block.google.calendarId), { account: block.google.account, calendarId: block.google.calendarId });
    }
    return [...found.values()];
  }
  async reconcile(reads, timeMin, timeMax) {
    const state = this.planner.state;
    const bodies = [];
    const missing = [];
    for (const block of Object.values(state.blocks)) {
      const link = block.google;
      if (!link || block.start < timeMin || block.start >= timeMax)
        continue;
      const read = reads.get(calendarKey(link.account, link.calendarId));
      if (!read || this.busy(block.id, read.readAt))
        continue;
      const session = read.sessions.find((item) => item.eventId === link.eventId);
      if (!session)
        missing.push({ blockId: block.id, link, readAt: read.readAt });
      else if (session.start !== block.start || session.end !== block.end)
        bodies.push({ type: "block.updated", blockId: block.id, start: session.start, end: session.end });
    }
    await Promise.all(missing.slice(0, MAX_LOOKUPS).map(async ({ blockId, link }) => {
      let event;
      try {
        event = await withDeadline(this.data.event(link.account, link.calendarId, link.eventId), READ_DEADLINE_MS, "Google Calendar");
      } catch {
        return;
      }
      if (!event)
        bodies.push({ type: "block.deleted", blockId });
      else if (event.start?.dateTime && event.end?.dateTime) {
        const start = new Date(event.start.dateTime).toISOString();
        const end = new Date(event.end.dateTime).toISOString();
        const block = this.planner.state.blocks[blockId];
        if (block && (block.start !== start || block.end !== end))
          bodies.push({ type: "block.updated", blockId, start, end });
      }
    }));
    const readAt = new Map([...reads].map(([key, read]) => [key, read.readAt]));
    let applied = 0;
    for (const body of bodies) {
      const blockId = body.blockId;
      const block = this.planner.state.blocks[blockId];
      if (!block?.google || this.busy(blockId, readAt.get(calendarKey(block.google.account, block.google.calendarId)) ?? 0))
        continue;
      if (await this.apply(body))
        applied++;
    }
    return applied;
  }
  busy(blockId, readAt) {
    return this.queues.has(blockId) || (this.written.get(blockId) ?? 0) >= readAt - SLACK_MS || this.planner.reloadedAt >= readAt - SLACK_MS;
  }
  observe(before, after) {
    const target = after.settings.googleTimebox;
    const renamed = new Set(Object.values(after.tasks).filter((task) => before.tasks[task.id] && before.tasks[task.id].title !== task.title).map((task) => task.id));
    for (const block of Object.values(after.blocks)) {
      const previous = before.blocks[block.id];
      const moved = !previous || previous.start !== block.start || previous.end !== block.end;
      const linked = Boolean(block.google ?? this.created.get(block.id));
      if (linked ? moved || renamed.has(block.taskId) : Boolean(target) && moved)
        this.enqueue(block.id, () => this.write(block.id));
    }
    for (const previous of Object.values(before.blocks)) {
      if (after.blocks[previous.id])
        continue;
      if (previous.google || this.created.has(previous.id) || this.queues.has(previous.id))
        this.enqueue(previous.id, () => this.remove(previous.id, previous.google ?? null));
    }
  }
  enqueue(blockId, job) {
    const next = (this.queues.get(blockId) ?? Promise.resolve()).then(job).then(() => {
      this.lastError = null;
    }, (error) => {
      this.lastError = messageOf(error);
      this.options.log?.(`Google Calendar: ${this.lastError}`);
    });
    this.queues.set(blockId, next);
    next.then(() => {
      if (this.queues.get(blockId) === next)
        this.queues.delete(blockId);
    });
  }
  async write(blockId) {
    const state = this.planner.state;
    const block = state.blocks[blockId];
    if (!block)
      return;
    const link = block.google ?? this.created.get(blockId) ?? null;
    const target = link ?? state.settings.googleTimebox;
    if (!target)
      return;
    const timebox = { blockId, taskId: block.taskId, title: state.tasks[block.taskId]?.title ?? "Planner", start: block.start, end: block.end };
    let eventId;
    try {
      eventId = await this.data.putTimebox(target.account, target.calendarId, timebox, link?.eventId ?? null);
    } catch (error) {
      if (!(link && isGone2(error)))
        throw error;
      eventId = await this.data.putTimebox(target.account, target.calendarId, timebox, null);
    }
    this.written.set(blockId, Date.now());
    this.options.onWrite?.();
    if (link?.eventId === eventId)
      return;
    const fresh = { account: target.account, calendarId: target.calendarId, eventId };
    this.created.set(blockId, fresh);
    if (this.planner.state.blocks[blockId] && await this.apply({ type: "block.linked", blockId, google: fresh }))
      this.created.delete(blockId);
  }
  async remove(blockId, link) {
    const target = link ?? this.created.get(blockId);
    this.created.delete(blockId);
    this.written.delete(blockId);
    if (!target)
      return;
    await this.data.deleteTimebox(target.account, target.calendarId, target.eventId);
    this.options.onWrite?.();
  }
  async apply(body) {
    await this.options.idle?.();
    this.internal = true;
    try {
      const result = this.planner.execute([{ cmd: newId(), ...body }]);
      if (!result.ok)
        this.options.log?.(`Google Calendar: could not record ${body.type}: ${result.error}`);
      return result.ok;
    } finally {
      this.internal = false;
    }
  }
}

// service/googleRoutes.ts
var isEmail = (value) => typeof value === "string" && /^[^\s@]{1,100}@[^\s@]{1,100}$/.test(value);
var isId2 = (value) => typeof value === "string" && value.length > 0 && value.length <= 1024;
var isTitle2 = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 1024;
var ok = (body) => ({ status: 200, body });
var bad = (error) => ({ status: 400, body: { error } });
var sendOf = (value) => value === "all" ? "all" : "none";
var scopeOf = (value) => value === undefined ? "this" : EDIT_SCOPES.includes(value) ? value : null;
var RESPONSES2 = ["accepted", "declined", "tentative"];
var googleWriteRoute = async (req, url, ctx) => {
  const path = url.pathname;
  const method = req.method;
  const query = (name) => url.searchParams.get(name);
  const body = async () => await ctx.readJson(req);
  if (path === "/google/event" && method === "GET") {
    const [account, calendar, id] = [query("account"), query("calendar"), query("id")];
    if (!isEmail(account) || !isId2(calendar) || !isId2(id))
      return bad("account, calendar and id are required");
    return ok({ event: await ctx.data.eventDetail(account, calendar, id) });
  }
  if (path === "/google/events" && (method === "POST" || method === "PATCH")) {
    const input = await body();
    if (!isEmail(input.account) || !isId2(input.calendarId))
      return bad("account and calendarId are required");
    if (typeof input.event !== "object" || input.event === null)
      return bad("event is required");
    if (method === "POST") {
      const event = await ctx.data.insertEvent(input.account, input.calendarId, input.event, sendOf(input.sendUpdates));
      ctx.changed("calendar");
      return ok({ event });
    }
    const scope = scopeOf(input.scope);
    if (!isId2(input.eventId) || !scope)
      return bad("eventId and a scope (this, following or all) are required");
    try {
      return ok({ requests: await ctx.data.updateEvent(input.account, input.calendarId, input.eventId, input.event, scope, sendOf(input.sendUpdates), ctx.zone()) });
    } finally {
      ctx.changed("calendar");
    }
  }
  if (path === "/google/events" && method === "DELETE") {
    const [account, calendar, id, scope] = [query("account"), query("calendar"), query("id"), scopeOf(query("scope") ?? undefined)];
    if (!isEmail(account) || !isId2(calendar) || !isId2(id) || !scope)
      return bad("account, calendar, id and a scope are required");
    try {
      return ok(await ctx.data.deleteEvent(account, calendar, id, scope, sendOf(query("sendUpdates"))));
    } finally {
      ctx.changed("calendar");
    }
  }
  if (path === "/google/events/restore" && method === "POST") {
    const input = await body();
    if (!isId2(input?.token))
      return bad("token is required");
    try {
      await ctx.data.restoreEvent(input.token);
      return ok({ restored: true });
    } finally {
      ctx.changed("calendar");
    }
  }
  if (path === "/google/events/respond" && method === "POST") {
    const input = await body();
    if (!isEmail(input.account) || !isId2(input.calendarId) || !isId2(input.eventId))
      return bad("account, calendarId and eventId are required");
    if (!RESPONSES2.includes(input.response))
      return bad("response must be accepted, declined or tentative");
    const scope = input.scope === "all" ? "all" : "this";
    try {
      return ok({ requests: await ctx.data.respond(input.account, input.calendarId, input.eventId, input.response, scope) });
    } finally {
      ctx.changed("calendar");
    }
  }
  if (path === "/google/events/move" && method === "POST") {
    const input = await body();
    if (!isEmail(input.account) || !isId2(input.calendarId) || !isId2(input.eventId) || !isId2(input.destination))
      return bad("account, calendarId, eventId and destination are required");
    try {
      return ok({ event: await ctx.data.moveEvent(input.account, input.calendarId, input.eventId, input.destination, sendOf(input.sendUpdates)) });
    } finally {
      ctx.changed("calendar");
    }
  }
  if (path === "/google/tasklists" && method === "POST") {
    const input = await body();
    if (!isEmail(input.account) || !isTitle2(input.title))
      return bad("account and a title (at most 1024 characters) are required");
    const list = await ctx.data.createTaskList(input.account, input.title.trim());
    return ok({ list });
  }
  if (path === "/google/tasklists" && method === "PATCH") {
    const input = await body();
    if (!isEmail(input.account) || !isId2(input.listId) || !isTitle2(input.title))
      return bad("account, listId and a title are required");
    return ok({ list: await ctx.data.renameTaskList(input.account, input.listId, input.title.trim()) });
  }
  if (path === "/google/tasklists" && method === "DELETE") {
    const [account, list] = [query("account"), query("list")];
    if (!isEmail(account) || !isId2(list))
      return bad("account and list are required");
    try {
      await ctx.data.deleteTaskList(account, list);
      return ok({ deleted: true });
    } finally {
      ctx.changed("tasks");
    }
  }
  if (path === "/google/tasks/all" && method === "GET") {
    const [account, list] = [query("account"), query("list")];
    if (!isEmail(account) || !isId2(list))
      return bad("account and list are required");
    return ok(await ctx.data.allTasks(account, list));
  }
  if (path === "/google/tasks" && method === "DELETE") {
    const [account, list, id] = [query("account"), query("list"), query("id")];
    if (!isEmail(account) || !isId2(list) || !isId2(id))
      return bad("account, list and id are required");
    try {
      await ctx.data.deleteTask(account, list, id);
      return ok({ deleted: true });
    } finally {
      ctx.changed("tasks");
    }
  }
  if (path === "/google/tasks/next" && method === "POST") {
    const input = await body();
    if (!isEmail(input.account) || !isId2(input.listId) || !isId2(input.id))
      return bad("account, listId and id are required");
    try {
      return ok({ ...await ctx.series.next(input.account, input.listId, input.id), ...ctx.snapshot() });
    } finally {
      ctx.changed("tasks");
    }
  }
  if (path === "/google/tasks/series" && method === "DELETE") {
    const [account, series, from, task] = [query("account"), query("series"), query("from"), query("task")];
    if (!isEmail(account) || !isId2(series))
      return bad("account and series are required");
    if (from !== null && !isDateKey(from) || task !== null && !isId2(task))
      return bad("from must be a date, task a task id");
    try {
      return ok({ ...await ctx.series.remove(account, series, from, task), ...ctx.snapshot() });
    } finally {
      ctx.changed("tasks");
    }
  }
  if (path === "/google/tasks/move" && method === "POST") {
    const input = await body();
    if (!isEmail(input.account) || !isId2(input.listId) || !isId2(input.id))
      return bad("account, listId and id are required");
    for (const key of ["parent", "previous", "destinationListId"])
      if (input[key] !== undefined && input[key] !== null && !isId2(input[key]))
        return bad(`${key} must be a task or list id`);
    try {
      const task = await ctx.data.moveTask(input.account, input.listId, input.id, { parent: input.parent ?? null, previous: input.previous ?? null, destination: input.destinationListId ?? null });
      return ok({ task });
    } finally {
      ctx.changed("tasks");
    }
  }
  return null;
};

// src/domain/gcalendar.ts
var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
var SHORT = MONTHS.map((month) => month.slice(0, 3));
var parts2 = (key) => ({ year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)), day: Number(key.slice(8)) });
var keyOf2 = (year, month, day) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
var daysInMonth4 = (key) => {
  const { year, month } = parts2(key);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
};
var addMonths = (key, n) => {
  const { year, month, day } = parts2(key);
  const index = year * 12 + (month - 1) + n;
  const first = keyOf2(Math.floor(index / 12), index % 12 + 1, 1);
  return keyOf2(Math.floor(index / 12), index % 12 + 1, Math.min(day, daysInMonth4(first)));
};

// src/domain/gtaskKept.ts
var keptFor = (state, item) => state.googleTasks?.[googleTaskKey(item.account, item.id)] ?? null;
var nthWeekday = (monthKey, code) => {
  const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(code);
  if (!match)
    return null;
  const nth = Number(match[1] ?? "1");
  const day = WEEKDAY_CODES.indexOf(match[2]);
  const first = `${monthKey.slice(0, 8)}01`;
  const length = daysInMonth4(first);
  const offset = (day - weekday(first) + 7) % 7;
  const dates = Array.from({ length: 5 }, (_, index) => 1 + offset + index * 7).filter((value) => value <= length);
  const chosen = nth > 0 ? dates[nth - 1] : dates[dates.length + nth];
  return chosen ? `${first.slice(0, 8)}${String(chosen).padStart(2, "0")}` : null;
};
var stepRule = (rule, date) => {
  const every = rule.interval;
  switch (rule.freq) {
    case "DAILY":
      return addDays(date, every);
    case "WEEKLY": {
      const days = [...new Set(rule.byDay.map((code) => WEEKDAY_CODES.indexOf(code.slice(-2))).filter((day) => day >= 0))];
      if (!days.length)
        return addDays(date, 7 * every);
      const start = WEEKDAY_CODES.indexOf(rule.other.find(([key]) => key === "WKST")?.[1] ?? "MO");
      const place = (day) => (day - Math.max(0, start) + 7) % 7;
      const sorted = days.sort((a, b) => place(a) - place(b));
      const here = place(weekday(date));
      const later = sorted.find((day) => place(day) > here);
      return later !== undefined ? addDays(date, place(later) - here) : addDays(date, 7 * every - here + place(sorted[0]));
    }
    case "MONTHLY":
      for (let step = 1;step <= 48; step++) {
        const month = addMonths(`${date.slice(0, 8)}01`, step * every);
        let candidate;
        if (rule.byDay.length === 1)
          candidate = nthWeekday(month, rule.byDay[0]);
        else {
          const wanted = rule.byMonthDay[0] ?? Number(date.slice(8));
          const length = daysInMonth4(month);
          const day = wanted < 0 ? length + wanted + 1 : wanted;
          candidate = day >= 1 && day <= length ? `${month.slice(0, 8)}${String(day).padStart(2, "0")}` : null;
        }
        if (candidate && candidate > date)
          return candidate;
      }
      return null;
    case "YEARLY":
      for (let step = 1;step <= 8; step++) {
        const year = Number(date.slice(0, 4)) + step * every;
        const month = rule.byMonth[0] ?? Number(date.slice(5, 7));
        const day = rule.byMonthDay[0] ?? Number(date.slice(8));
        const first = `${year}-${String(month).padStart(2, "0")}-01`;
        if (day >= 1 && day <= daysInMonth4(first))
          return `${first.slice(0, 8)}${String(day).padStart(2, "0")}`;
      }
      return null;
  }
};
var nextRepeatDate = (line, date, index) => {
  const rule = parseRRule(line);
  if (!rule)
    return null;
  if (rule.count !== null && index >= rule.count)
    return null;
  const next = stepRule(rule, date);
  if (!next)
    return null;
  const until = rule.until ? untilDate(rule.until, "UTC") : null;
  return until && next > until ? null : next;
};
var STEPS_MAX = 4000;
var scheduledOn = (kept, item) => kept.repeat?.on ?? item.due;
var templateOf = (task, kept, date, start = date) => ({
  title: task.title,
  notes: task.notes,
  time: kept.time,
  duration: kept.duration,
  deadline: kept.deadline ? daysBetween(date, kept.deadline) : null,
  start
});
var seriesTemplate = (kept, item) => {
  if (kept.repeat?.template)
    return kept.repeat.template;
  const on = scheduledOn(kept, item);
  return on ? templateOf(item, kept, on) : null;
};
var occurrenceValues = (template, on, change) => ({
  title: change?.title ?? template.title,
  notes: change?.notes ?? template.notes,
  due: change?.date ?? on,
  time: change?.time !== undefined ? change.time : template.time,
  duration: change?.time !== undefined ? change.duration ?? null : template.duration,
  deadline: change?.deadline !== undefined ? change.deadline : template.deadline === null ? null : addDays(on, template.deadline)
});
var withExceptions = (repeat, exceptions) => {
  const { exceptions: _old, ...rest } = repeat;
  return exceptions ? { ...rest, exceptions } : rest;
};
var occurrenceTask = (repeat, template, date, index) => {
  const values = occurrenceValues(template, date, repeat.exceptions?.[date]);
  const ahead = Object.entries(repeat.exceptions ?? {}).filter(([on]) => on > date);
  return {
    title: values.title,
    notes: values.notes,
    due: values.due,
    kept: {
      time: values.time,
      duration: values.duration,
      deadline: values.deadline,
      repeat: { rule: repeat.rule, seriesId: repeat.seriesId, index, next: null, on: date, template, ...ahead.length ? { exceptions: Object.fromEntries(ahead) } : {} }
    }
  };
};
var nextOccurrence = (item, kept) => {
  const repeat = kept.repeat;
  let date = scheduledOn(kept, item);
  let index = repeat?.index ?? 0;
  let found = null;
  for (let step = 0;repeat && date && !found && step < STEPS_MAX; step++) {
    date = nextRepeatDate(repeat.rule, date, index);
    if (!date)
      break;
    index += 1;
    if (!repeat.exceptions?.[date]?.skip)
      found = date;
  }
  return { item, kept, template: seriesTemplate(kept, item), date: found, index };
};
var deadlineGroups = (kept, accounts, from, to) => {
  const groups = new Map;
  for (const entry of Object.values(kept)) {
    if (!entry.deadline || entry.deadline < from || entry.deadline > to || !accounts.includes(entry.account))
      continue;
    const key = `${entry.account}
${entry.listId}`;
    const group = groups.get(key) ?? { account: entry.account, listId: entry.listId, ids: [] };
    group.ids.push(entry.taskId);
    groups.set(key, group);
  }
  return [...groups.values()];
};
var seriesNextIn = (state, items, repeat, except) => {
  const later = items.flatMap((item) => {
    const theirs = item.id === except ? null : keptFor(state, item)?.repeat;
    if (!theirs || theirs.seriesId !== repeat.seriesId)
      return [];
    return (theirs.on && repeat.on ? theirs.on > repeat.on : theirs.index > repeat.index) ? [{ item, on: theirs.on ?? "", index: theirs.index }] : [];
  });
  later.sort((a, b) => a.on.localeCompare(b.on) || a.index - b.index);
  return later[0]?.item ?? null;
};
var ruleEndingBefore = (line, from, on, index = 1) => {
  const rule = parseRRule(line);
  if (!rule)
    return line;
  const last = addDays(from, -1);
  const until = rule.until ? untilDate(rule.until, "UTC") : null;
  if (until && until <= last)
    return line;
  if (rule.count !== null && on) {
    let date = on;
    for (let step = 0, at = index;date && date < from && step < STEPS_MAX; step++)
      date = nextRepeatDate(line, date, at++);
    if (!date)
      return line;
  }
  return formatRRule({ ...rule, count: null, until: last.replace(/-/g, "") });
};
var endedBefore = (repeat, from) => {
  const before = Object.entries(repeat.exceptions ?? {}).filter(([on]) => on < from);
  return withExceptions({ ...repeat, rule: ruleEndingBefore(repeat.rule, from, repeat.on, repeat.index) }, before.length ? Object.fromEntries(before) : undefined);
};
var seriesCut = (kept, account, seriesId, from, chosen = null) => {
  const tasks = Object.values(kept).filter((entry) => entry.account === account && entry.repeat?.seriesId === seriesId);
  const goes = (entry) => from === null || entry.taskId === chosen || Boolean(entry.repeat.on && entry.repeat.on >= from);
  const remove = tasks.filter(goes).sort((a, b) => Number(Boolean(a.repeat.next)) - Number(Boolean(b.repeat.next)) || (b.repeat.on ?? "").localeCompare(a.repeat.on ?? "") || b.repeat.index - a.repeat.index);
  const keep = from === null ? [] : tasks.filter((entry) => !goes(entry)).map((entry) => ({ type: "gtask.kept", account, listId: entry.listId, taskId: entry.taskId, patch: { repeat: endedBefore(entry.repeat, from) } }));
  return { remove, keep };
};

// service/googleSeries.ts
var messageOf2 = (error) => error instanceof Error ? error.message : String(error);
var DONE_IN_ANSWER_MS = 5000;

class GoogleSeries {
  planner;
  data;
  options;
  changing = new Map;
  cleanup = Promise.resolve();
  constructor(planner, data, options = {}) {
    this.planner = planner;
    this.data = data;
    this.options = options;
  }
  async settled() {
    while (this.changing.size)
      await Promise.all([...this.changing.values()]);
    await this.cleanup;
  }
  next(account, listId, taskId) {
    const seriesId = keptFor(this.planner.state, { account, id: taskId })?.repeat?.seriesId;
    if (!seriesId)
      return Promise.resolve({ task: null, made: false });
    return this.one(account, seriesId, async () => {
      const state = this.planner.state;
      const kept = keptFor(state, { account, id: taskId });
      const repeat = kept?.repeat;
      if (!kept || !repeat)
        return { task: null, made: false };
      const tasks = (await this.data.allTasks(account, listId)).tasks;
      if (repeat.next) {
        const linked = keptFor(state, { account, id: repeat.next });
        const there = linked && linked.listId !== listId ? (await this.data.allTasks(account, linked.listId)).tasks : tasks;
        return { task: there.find((task) => task.id === repeat.next) ?? null, made: false };
      }
      const item = tasks.find((task) => task.id === taskId) ?? (repeat.on && repeat.template ? { account, listId, id: taskId, title: repeat.template.title, notes: repeat.template.notes, due: repeat.on, completed: false, parent: null, position: "", url: "", updated: "" } : null);
      if (!item)
        throw new GoogleError(404, TASK_GONE);
      const next = nextOccurrence(item, kept);
      if (!next.date || !next.template) {
        if (item.completed)
          this.write([{ type: "gtask.kept", account, listId: kept.listId, taskId, patch: { repeat: null } }]);
        return { task: null, made: false };
      }
      const link = (id) => ({ type: "gtask.kept", account, listId: kept.listId, taskId, patch: { repeat: { ...repeat, next: id } } });
      const found = seriesNextIn(state, tasks, repeat, taskId);
      if (found) {
        this.write([link(found.id)]);
        return { task: found, made: false };
      }
      const task = occurrenceTask(repeat, next.template, next.date, next.index);
      const made = await this.data.createTask(account, listId, { title: task.title.trim() || item.title, ...task.notes ? { notes: task.notes } : {}, due: task.due });
      if (!made)
        throw new GoogleError(502, "Google did not return the task");
      this.options.onWrite?.();
      try {
        this.write([link(made.id), { type: "gtask.kept", account: made.account, listId: made.listId, taskId: made.id, patch: task.kept }]);
      } catch (error) {
        await this.data.deleteTask(account, made.listId, made.id).catch(() => {});
        throw error;
      }
      return { task: made, made: true };
    });
  }
  remove(account, seriesId, from, chosen) {
    const until = Date.now() + DONE_IN_ANSWER_MS;
    return this.one(account, seriesId, async () => {
      const { remove, keep } = seriesCut(this.planner.state.googleTasks, account, seriesId, from, chosen);
      if (!remove.length && !keep.length)
        throw new GoogleError(404, "Google Tasks no longer has this series");
      const first = remove.filter((kept) => !kept.repeat?.next || kept.taskId === chosen);
      const gone = [];
      try {
        for (const kept of first) {
          await this.data.deleteTask(account, kept.listId, kept.taskId);
          gone.push(kept.taskId);
        }
      } catch (error) {
        if (gone.length)
          this.write(gone.map((taskId) => ({ type: "gtask.dropped", account, taskId })));
        throw error;
      } finally {
        if (gone.length)
          this.options.onWrite?.();
      }
      this.write([...remove.map((kept) => ({ type: "gtask.dropped", account, taskId: kept.taskId })), ...keep]);
      const left = await this.deleteDone(account, remove.filter((kept) => !first.includes(kept)), until);
      if (left.length)
        this.cleanup = this.cleanup.then(() => this.deleteDone(account, left, Infinity)).then(() => {
          return;
        });
      return { deleted: remove.map((kept) => kept.taskId) };
    });
  }
  async deleteDone(account, tasks, until) {
    const failed = [];
    let done = 0;
    for (;done < tasks.length && Date.now() < until; done++) {
      try {
        await this.data.deleteTask(account, tasks[done].listId, tasks[done].taskId);
      } catch (error) {
        failed.push(messageOf2(error));
      }
    }
    if (done)
      this.options.onWrite?.();
    if (failed.length)
      this.options.log?.(`Google Tasks kept ${failed.length} completed tasks of a deleted series: ${failed[0]}`);
    return tasks.slice(done);
  }
  one(account, seriesId, work) {
    const key = `${account}
${seriesId}`;
    const run = (this.changing.get(key) ?? Promise.resolve()).then(async () => {
      await this.options.idle?.();
      return work();
    });
    const done = run.then(() => {
      return;
    }, () => {
      return;
    });
    this.changing.set(key, done);
    done.then(() => {
      if (this.changing.get(key) === done)
        this.changing.delete(key);
    });
    return run;
  }
  write(bodies) {
    const result = this.planner.execute(bodies.map((body) => ({ cmd: newId(), ...body })));
    if (!result.ok)
      throw new GoogleError(500, `The Planner did not keep it: ${result.error}`);
  }
}

// service/agents.ts
import { execFile as execFile3 } from "node:child_process";
import { existsSync as existsSync4, mkdirSync as mkdirSync3, readFileSync as readFileSync3, readdirSync as readdirSync2, renameSync, rmSync, statSync, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute as isAbsolute2, join as join3, relative, sep } from "node:path";
var opencodeConfigDir = (env = process.env) => env.XDG_CONFIG_HOME ? join3(env.XDG_CONFIG_HOME, "opencode") : join3(env.HOME || homedir(), ".config", "opencode");
var scalar = (raw) => {
  const text = raw.trim();
  if (text.startsWith('"')) {
    const end = text.lastIndexOf('"');
    try {
      return JSON.parse(text.slice(0, end + 1));
    } catch {
      return text.slice(1, end > 0 ? end : undefined);
    }
  }
  if (text.startsWith("'")) {
    const end = text.lastIndexOf("'");
    return text.slice(1, end > 0 ? end : undefined).replace(/''/g, "'");
  }
  const value = text.replace(/\s+#.*$/, "").trim();
  if (value === "" || value === "~" || value === "null" || value === "|" || value === ">" || value === "|-" || value === ">-")
    return null;
  if (value === "true" || value === "false")
    return value === "true";
  if (/^-?\d+(\.\d+)?$/.test(value))
    return Number(value);
  return value;
};
var parseFrontmatter = (text) => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const data = {};
  if (!match)
    return data;
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s/.test(line) || line.trimStart().startsWith("#"))
      continue;
    const entry = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/.exec(line);
    if (entry)
      data[entry[1]] = scalar(entry[2]);
  }
  return data;
};
var parseJsonc = (text) => {
  let out = "";
  let inString = false;
  for (let index = 0;index < text.length; index++) {
    const char = text[index];
    if (inString) {
      out += char;
      if (char === "\\")
        out += text[++index] ?? "";
      else if (char === '"')
        inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== `
`)
        index++;
      out += `
`;
    } else if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/"))
        index++;
      index++;
    } else if (char === ",") {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next]))
        next++;
      if (text[next] !== "}" && text[next] !== "]")
        out += char;
    } else
      out += char;
  }
  return JSON.parse(out);
};
var BUILT_IN = {
  build: { label: "Build", description: "The default agent. Executes tools based on configured permissions.", mode: "primary", hidden: false },
  plan: { label: "Plan", description: "Read-only agent for exploring the codebase and planning work before implementation.", mode: "primary", hidden: false },
  general: { label: "General", description: "General-purpose agent for researching complex questions and executing multi-step tasks.", mode: "subagent", hidden: false },
  explore: { label: "Explore", description: "Fast agent specialized for exploring codebases.", mode: "subagent", hidden: false },
  compaction: { label: "Compaction", description: null, mode: "primary", hidden: true },
  title: { label: "Title", description: null, mode: "primary", hidden: true },
  summary: { label: "Summary", description: null, mode: "primary", hidden: true }
};
var MAX_FILES = 300;
var MAX_FILE_BYTES = 256000;
var readSmall = (file) => {
  try {
    const stat = statSync(file);
    return stat.isFile() && stat.size <= MAX_FILE_BYTES ? readFileSync3(file, "utf8") : null;
  } catch {
    return null;
  }
};
var markdownFiles = (dir, recursive, budget) => {
  const found = [];
  const walk = (current, depth) => {
    let entries;
    try {
      entries = readdirSync2(current).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget.left <= 0)
        return;
      const file = join3(current, entry);
      let stat;
      try {
        stat = statSync(file);
      } catch {
        continue;
      }
      if (stat.isDirectory() && recursive && depth < 4)
        walk(file, depth + 1);
      else if (stat.isFile() && entry.endsWith(".md")) {
        budget.left--;
        found.push({ name: relative(dir, file).split(sep).join("/").replace(/\.md$/, ""), file });
      }
    }
  };
  walk(dir, 0);
  return found;
};
var discoverAgents = (configDir, projectDir) => {
  const agents = new Map(Object.entries(BUILT_IN).map(([name, entry]) => [name, { ...entry, model: null, color: null, source: "built-in" }]));
  let defaultAgent = null;
  const budget = { left: MAX_FILES };
  const apply = (name, def, source) => {
    if (!isAgentName(name))
      return;
    if (def.disabled === true || def.disable === true) {
      agents.delete(name);
      return;
    }
    const entry = agents.get(name) ?? { label: agentLabel(name), description: null, model: null, color: null, mode: "primary", hidden: false, source };
    if (def.mode === "primary" || def.mode === "subagent" || def.mode === "all")
      entry.mode = def.mode;
    if (typeof def.hidden === "boolean")
      entry.hidden = def.hidden;
    if (typeof def.description === "string" && def.description.trim())
      entry.description = def.description.trim().slice(0, 300);
    if (typeof def.color === "string" && /^#[0-9a-fA-F]{6}$/.test(def.color))
      entry.color = def.color;
    if (typeof def.model === "string") {
      const model = !def.model.includes("#") && typeof def.variant === "string" ? `${def.model}#${def.variant}` : def.model;
      if (isModelRef(model))
        entry.model = model;
    }
    agents.set(name, entry);
  };
  const fromJson = (file, source) => {
    const text = readSmall(file);
    if (text === null)
      return;
    let data;
    try {
      data = parseJsonc(text);
    } catch {
      return;
    }
    const config = data;
    if (!config || typeof config !== "object")
      return;
    for (const key of ["agent", "agents"]) {
      const block = config[key];
      if (!block || typeof block !== "object" || Array.isArray(block))
        continue;
      for (const [name, def] of Object.entries(block)) {
        if (def && typeof def === "object" && !Array.isArray(def))
          apply(name, def, source);
      }
    }
    if (typeof config.default_agent === "string" && isAgentName(config.default_agent))
      defaultAgent = config.default_agent;
  };
  const fromFolder = (dir, source) => {
    for (const sub of ["agent", "agents"]) {
      for (const { name, file } of markdownFiles(join3(dir, sub), true, budget)) {
        const text = readSmall(file);
        if (text !== null)
          apply(name, parseFrontmatter(text), source);
      }
    }
    for (const sub of ["mode", "modes"]) {
      for (const { name, file } of markdownFiles(join3(dir, sub), false, budget)) {
        const text = readSmall(file);
        if (text !== null)
          apply(name, { ...parseFrontmatter(text), mode: "primary" }, source);
      }
    }
  };
  fromJson(join3(configDir, "opencode.json"), "global");
  fromJson(join3(configDir, "opencode.jsonc"), "global");
  fromFolder(configDir, "global");
  if (projectDir && isAbsolute2(projectDir) && existsSync4(projectDir)) {
    fromJson(join3(projectDir, "opencode.json"), "project");
    fromJson(join3(projectDir, "opencode.jsonc"), "project");
    fromJson(join3(projectDir, ".opencode", "opencode.json"), "project");
    fromJson(join3(projectDir, ".opencode", "opencode.jsonc"), "project");
    fromFolder(join3(projectDir, ".opencode"), "project");
  }
  return { agents: orderAgents([...agents].filter(([, entry]) => entry.mode !== "subagent" && !entry.hidden).map(([name, entry]) => toAgent(name, entry))), defaultAgent };
};
var toAgent = (name, entry) => ({ name, label: entry.label, description: entry.description, model: entry.model, color: entry.color, source: entry.source });
var orderAgents = (agents) => {
  const rank = (name) => name === "build" ? 0 : name === "plan" ? 1 : 2;
  return agents.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
};
var parseModels = (out) => [...new Set(out.split(/\r?\n/).map((line) => line.trim()).filter((line) => isModelRef(line) && !line.includes("#")))].sort((a, b) => a.localeCompare(b));
var dataOf = (json) => {
  const data = json?.data;
  return Array.isArray(data) ? data : [];
};
var parseModelDetails = (json) => {
  const details = new Map;
  for (const item of dataOf(json)) {
    const model = item;
    if (typeof model.id !== "string" || typeof model.providerID !== "string")
      continue;
    const id = `${model.providerID}/${model.id}`;
    if (!isModelRef(id))
      continue;
    const variants = Array.isArray(model.variants) ? model.variants.flatMap((variant) => {
      const value = typeof variant === "string" ? variant : variant?.id ?? variant?.name;
      return typeof value === "string" && /^[^\s#]{1,40}$/.test(value) ? [value] : [];
    }) : [];
    details.set(id, { name: typeof model.name === "string" && model.name.trim() ? model.name.trim().slice(0, 80) : null, variants });
  }
  return details;
};
var parseLiveAgents = (json) => dataOf(json).flatMap((item) => {
  const agent = item;
  if (!isAgentName(agent.id) || agent.mode === "subagent" || agent.hidden === true)
    return [];
  const ref = agent.model;
  const model = ref && typeof ref.providerID === "string" && typeof ref.id === "string" ? `${ref.providerID}/${ref.id}${typeof ref.variant === "string" && ref.variant ? `#${ref.variant}` : ""}` : null;
  return [{
    name: agent.id,
    label: typeof agent.name === "string" && agent.name.trim() ? agent.name.trim().slice(0, 60) : agentLabel(agent.id),
    description: typeof agent.description === "string" && agent.description.trim() ? agent.description.trim().slice(0, 300) : null,
    model: model && isModelRef(model) ? model : null,
    color: typeof agent.color === "string" && /^#[0-9a-fA-F]{6}$/.test(agent.color) ? agent.color : null,
    source: "global"
  }];
});
var parseCommandNames = (json) => dataOf(json).flatMap((item) => {
  const name = item?.name;
  return typeof name === "string" ? [name] : [];
});
var opencodeRunner = (args, options) => new Promise((resolve, reject) => {
  execFile3("opencode", args, { timeout: options?.timeoutMs ?? 1e4, maxBuffer: 16000000, ...options?.cwd ? { cwd: options.cwd } : {}, env: { ...process.env, NO_COLOR: "1" } }, (error, stdout, stderr) => {
    if (error)
      reject(Object.assign(new Error(`${error.message}
${stderr}`), { code: error.code, stderr: String(stderr) }));
    else
      resolve(stdout);
  });
});
var MODELS_TTL_MS = 10 * 60000;
var AGENTS_TTL_MS = 60000;
var STATUS_TTL_MS = 30000;
var MODELS_WAIT_MS = 3000;
var LISTED_WAIT_MS = 6000;
var LISTED_POLL_MS = 300;
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var messageOf3 = (error) => {
  const failure = error;
  if (failure.code === "ENOENT")
    return "The OpenCode CLI (opencode) is not on the PATH where OpenChamber runs.";
  return `${failure.stderr || failure.message || String(error)}`.trim().split(`
`)[0].slice(0, 300);
};
var locationQuery = (directory) => `location%5Bdirectory%5D=${encodeURIComponent(directory)}`;

class OpenCodeInfo {
  run;
  now;
  status = null;
  models = null;
  loadingModels = null;
  live = new Map;
  constructor(run = opencodeRunner, now = Date.now) {
    this.run = run;
    this.now = now;
  }
  async server() {
    if (this.status && this.now() - this.status.at < STATUS_TTL_MS)
      return this.status.url;
    let url = null;
    try {
      const out = (await this.run(["service", "status"], { timeoutMs: 5000 })).trim();
      url = /^https?:\/\//.test(out) ? out : null;
    } catch {
      url = null;
    }
    this.status = { url, at: this.now() };
    return url;
  }
  async api(path) {
    return JSON.parse(await this.run(["api", "GET", path], { timeoutMs: 6000 }));
  }
  async modelList(directory, refresh = false) {
    const stale = !this.models || refresh || this.now() - this.models.at > MODELS_TTL_MS;
    if (stale && !this.loadingModels) {
      this.loadingModels = this.loadModels(directory).finally(() => {
        this.loadingModels = null;
      });
    }
    if (this.models && !refresh)
      return { models: this.models.list, error: this.models.error };
    const done = await Promise.race([this.loadingModels.then(() => true), sleep(MODELS_WAIT_MS).then(() => false)]);
    if (!done || !this.models)
      return { models: this.models?.list ?? [], error: null, pending: true };
    return { models: this.models.list, error: this.models.error };
  }
  async loadModels(directory) {
    const cwd = directory && isAbsolute2(directory) && existsSync4(directory) ? directory : undefined;
    try {
      const running = await this.server();
      const ids = parseModels(await this.run(running ? ["models"] : ["models", "--standalone"], { cwd, timeoutMs: running ? 1e4 : 15000 }));
      const details = running ? await this.api(`/api/model?${locationQuery(cwd ?? homedir())}`).then(parseModelDetails).catch(() => new Map) : new Map;
      this.models = { at: this.now(), list: ids.map((id) => ({ id, name: details.get(id)?.name ?? null, variants: details.get(id)?.variants ?? [] })), error: ids.length ? null : "OpenCode lists no models; connect a provider in OpenChamber." };
    } catch (error) {
      this.models = { at: this.now(), list: this.models?.list ?? [], error: messageOf3(error) };
    }
  }
  async liveAgents(directory) {
    const cached = this.live.get(directory);
    if (cached && this.now() - cached.at < AGENTS_TTL_MS)
      return cached.agents;
    let agents = null;
    if (await this.server())
      agents = await this.api(`/api/agent?${locationQuery(directory)}`).then(parseLiveAgents).catch(() => null);
    this.live.set(directory, { at: this.now(), agents });
    return agents;
  }
  async commands(directory) {
    if (!await this.server())
      return null;
    return this.api(`/api/command?${locationQuery(directory)}`).then(parseCommandNames).catch(() => null);
  }
  async waitListed(names, directory) {
    const until = this.now() + LISTED_WAIT_MS;
    for (;; ) {
      const listed = await this.commands(directory);
      if (listed === null)
        return null;
      if (names.every((name) => listed.includes(name)))
        return true;
      if (this.now() >= until)
        return false;
      await sleep(LISTED_POLL_MS);
    }
  }
}
var mergeAgents = (fromConfig, live) => {
  if (!live)
    return [...fromConfig];
  const known = new Map(fromConfig.map((agent) => [agent.name, agent]));
  return orderAgents(live.map((agent) => ({ ...agent, source: known.get(agent.name)?.source ?? agent.source, description: agent.description ?? known.get(agent.name)?.description ?? null })));
};
var AGENT_COMMAND_MS = 3 * 60000;

class CommandFiles {
  configDir;
  log;
  agentCommandMs;
  lastPresets = null;
  retiring = new Map;
  constructor(configDir, log = () => {}, agentCommandMs = AGENT_COMMAND_MS) {
    this.configDir = configDir;
    this.log = log;
    this.agentCommandMs = agentCommandMs;
  }
  get dir() {
    return join3(this.configDir, "command");
  }
  ensure(entries) {
    if (entries.length === 0)
      return [];
    mkdirSync3(this.dir, { recursive: true });
    return entries.map(({ assignee, kind }) => {
      const name = commandName(assignee);
      const file = join3(this.dir, `${name}.md`);
      const content = commandFile(assignee, kind);
      const current = readSmall(file);
      if (kind === "agent")
        this.retire(name);
      if (current === content)
        return { id: assignee.id, name, changed: false };
      if (current !== null && !current.includes(COMMAND_MARKER))
        throw new Error(`${file} exists and was not written by the Planner`);
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync3(temporary, content, { mode: 420 });
      renameSync(temporary, file);
      return { id: assignee.id, name, changed: true };
    });
  }
  retire(name) {
    clearTimeout(this.retiring.get(name));
    const timer = setTimeout(() => {
      this.retiring.delete(name);
      const file = join3(this.dir, `${name}.md`);
      if (readSmall(file)?.startsWith(`---
${COMMAND_MARKER} (agent)`))
        rmSync(file, { force: true });
    }, this.agentCommandMs);
    timer.unref?.();
    this.retiring.set(name, timer);
  }
  retireLeftovers() {
    let files = [];
    try {
      files = readdirSync2(this.dir);
    } catch {
      return;
    }
    for (const file of files) {
      if (file.startsWith(COMMAND_PREFIX) && file.endsWith(".md") && readSmall(join3(this.dir, file))?.startsWith(`---
${COMMAND_MARKER} (agent)`))
        this.retire(file.slice(0, -".md".length));
    }
  }
  syncPresets(presets) {
    const key = JSON.stringify(presets);
    if (key === this.lastPresets)
      return;
    try {
      this.ensure(presets.map((preset) => ({ assignee: presetAssignee(preset), kind: "preset" })));
      const wanted = new Set(presets.map((preset) => `${commandName(preset)}.md`));
      let files = [];
      try {
        files = readdirSync2(this.dir);
      } catch {
        files = [];
      }
      for (const file of files) {
        if (!file.startsWith(COMMAND_PREFIX) || !file.endsWith(".md") || wanted.has(file))
          continue;
        if (readSmall(join3(this.dir, file))?.startsWith(`---
${COMMAND_MARKER} (preset)`))
          rmSync(join3(this.dir, file), { force: true });
      }
      this.lastPresets = key;
    } catch (error) {
      this.log(`agent commands: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
var isDirectory = (value) => typeof value === "string" && value.length <= 1024 && isAbsolute2(value);
var agentCatalog = async (deps, directory, refresh) => {
  const fromConfig = discoverAgents(deps.configDir, directory);
  const [live, models] = await Promise.all([deps.info.liveAgents(directory ?? homedir()), deps.info.modelList(directory, refresh)]);
  return { agents: mergeAgents(fromConfig.agents, live), defaultAgent: fromConfig.defaultAgent, models: models.models, modelsError: models.error, ...models.pending ? { modelsPending: true } : {}, configDir: deps.configDir };
};
var agentRoute = async (req, url, deps) => {
  if (url.pathname === "/agents" && req.method === "GET") {
    const directory = url.searchParams.get("directory");
    if (directory !== null && !isDirectory(directory))
      return { status: 400, body: { error: "directory must be an absolute path" } };
    return { status: 200, body: await agentCatalog(deps, directory, url.searchParams.get("refresh") === "1") };
  }
  if (url.pathname === "/agents/commands" && req.method === "POST") {
    const body = await deps.readJson(req);
    const entries = Array.isArray(body.entries) ? body.entries : [];
    if (entries.length > 40 || !entries.every((entry) => isRunAssignee(entry?.assignee) && ["preset", "agent"].includes(entry.kind))) {
      return { status: 400, body: { error: "entries must be at most 40 of { assignee, kind: preset | agent }" } };
    }
    if (body.directory !== undefined && body.directory !== null && !isDirectory(body.directory))
      return { status: 400, body: { error: "directory must be an absolute path" } };
    let commands;
    try {
      commands = deps.commands.ensure(entries);
    } catch (error) {
      return { status: 409, body: { error: `Could not write the agent command in ${deps.commands.dir}: ${error instanceof Error ? error.message : String(error)}` } };
    }
    const listed = body.wait === true && commands.length ? await deps.info.waitListed(commands.map((command) => command.name), body.directory ?? homedir()) : null;
    return { status: 200, body: { commands, listed, dir: deps.commands.dir } };
  }
  return null;
};

// service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var BODY_LIMIT = 1e6;
var SYNC_ANSWER_MS = 20000;
var dir = process.env.PLANNER_DATA_DIR || join4(homedir2(), ".local", "share", "openchamber-planner", "data");
var log = (message) => console.error(`[planner] ${message}`);
var sync = null;
var store = new EventStore({ dir, log, onCommit: () => sync?.schedule() });
await store.init();
var planner = new Planner(store);
sync = new SyncManager(store, planner, log);
await sync.init();
var snapshot = () => ({ ...planner.snapshot(), sync: sync.status() });
var github = new GitHubSource;
var feeds = new CalendarFeeds(join4(dirname3(dir), "cache"));
var linearWorkspaces = new LinearWorkspaces(join4(dirname3(dir), "linear-workspaces.json"), undefined, log);
var google = new GoogleAccounts(join4(dirname3(dir), "google-accounts.json"), undefined, undefined, log);
var googleData = new GoogleData(google);
var googleCalendars = new GoogleCalendars(googleData);
var googleDueTasks = new GoogleDueTasks(googleData);
var timeboxes = new GoogleTimeboxes(planner, googleData, { idle: () => sync.idle(), log, onWrite: () => googleCalendars.forget() });
var series = new GoogleSeries(planner, googleData, { idle: () => sync.idle(), log, onWrite: () => googleDueTasks.forget() });
var opencodeConfig = opencodeConfigDir();
var opencodeInfo = new OpenCodeInfo;
var agentCommands = new CommandFiles(opencodeConfig, log);
var syncAgentCommands = () => agentCommands.syncPresets(planner.state.settings.agentPresets ?? []);
syncAgentCommands();
agentCommands.retireLeftovers();
var json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
var PULL_LOOKUPS_PER_REQUEST = 4;
var isLookup = (value) => {
  const lookup = value;
  return typeof lookup?.runId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(lookup.runId) && (lookup.branch === null || typeof lookup.branch === "string" && lookup.branch.length <= 200) && (lookup.url === undefined || typeof lookup.url === "string" && lookup.url.length <= 300) && Array.isArray(lookup.directories) && lookup.directories.length <= 3 && lookup.directories.every((item) => typeof item === "string" && item.length <= 1024);
};
var mapLimited2 = async (items, limit, fn) => {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
};
var isEmail2 = (value) => typeof value === "string" && /^[^\s@]{1,100}@[^\s@]{1,100}$/.test(value);
var isGoogleId = (value) => typeof value === "string" && value.length > 0 && value.length <= 1024;
var perAccount = async (feature, ask) => {
  const accounts = (await google.status()).accounts.filter((account) => account.features.includes(feature));
  const items = [];
  const errors = [];
  await Promise.all(accounts.map(async (account) => {
    try {
      items.push(...await ask(account.email));
    } catch (error) {
      errors.push({ account: account.email, message: error instanceof Error ? error.message : String(error) });
    }
  }));
  return { items, errors };
};
var googleRoute = async (req, url) => {
  const path = url.pathname;
  const ok = (body) => ({ status: 200, body });
  const written = await googleWriteRoute(req, url, { data: googleData, series, snapshot, readJson, zone: () => planner.state.settings.timezone ?? "UTC", changed: (what) => (what === "calendar" ? googleCalendars : googleDueTasks).forget() });
  if (written)
    return written;
  if (path === "/google/status" && req.method === "GET")
    return ok({ ...await google.status(), timeboxError: timeboxes.lastError });
  if (path === "/google/client" && req.method === "PUT") {
    const body = await readJson(req);
    if (typeof body.id !== "string" || typeof body.secret !== "string")
      return { status: 400, body: { error: "id and secret must be strings" } };
    return ok(await google.setClient(body.id, body.secret));
  }
  if (path === "/google/client" && req.method === "DELETE")
    return ok(await google.clearClient());
  if (path === "/google/connect" && req.method === "POST") {
    const body = await readJson(req);
    const features = Array.isArray(body.features) ? GOOGLE_FEATURES.filter((feature) => body.features.includes(feature)) : [];
    return ok(await google.startSignIn(features));
  }
  const signIn = /^\/google\/connect\/([A-Za-z0-9_-]{8,40})(\/finish)?$/.exec(path);
  if (signIn && !signIn[2] && req.method === "GET")
    return ok(google.signIn(signIn[1]));
  if (signIn && signIn[2] && req.method === "POST") {
    const body = await readJson(req);
    if (typeof body.url !== "string" || body.url.length > 4000)
      return { status: 400, body: { error: "url must be the address the browser was sent to" } };
    return ok(await google.finishSignIn(signIn[1], body.url));
  }
  const account = /^\/google\/accounts\/([^/]+)$/.exec(path);
  if (account && req.method === "DELETE")
    return ok({ removed: await google.remove(decodeURIComponent(account[1])) });
  if (path === "/google/calendars" && req.method === "GET") {
    const { items, errors } = await perAccount("calendar", (email) => googleData.calendars(email));
    return ok({ calendars: items, errors });
  }
  if (path === "/google/tasklists" && req.method === "GET") {
    const { items, errors } = await perAccount("tasks", (email) => googleData.taskLists(email));
    return ok({ lists: items, errors });
  }
  if (path === "/google/tasks" && req.method === "GET") {
    const email = url.searchParams.get("account");
    const list = url.searchParams.get("list");
    if (!isEmail2(email) || !isGoogleId(list))
      return { status: 400, body: { error: "account and list are required" } };
    return ok({ tasks: await googleData.tasks(email, list) });
  }
  if (path === "/google/tasks/linked" && req.method === "POST") {
    const body = await readJson(req);
    const groups = (Array.isArray(body.groups) ? body.groups : []).filter((group) => isEmail2(group?.account) && isGoogleId(group?.listId) && Array.isArray(group?.ids) && group.ids.every(isGoogleId));
    if (groups.length > 10 || groups.some((group) => group.ids.length > 50))
      return { status: 400, body: { error: "at most 10 lists of 50 tasks per request" } };
    const tasks = [];
    const missing = [];
    const errors = [];
    await Promise.all(groups.map(async (group) => {
      try {
        const found = await googleData.linkedTasks(group.account, group.listId, group.ids);
        tasks.push(...found.tasks);
        missing.push(...found.missing.map((id) => ({ account: group.account, listId: group.listId, id })));
      } catch (error) {
        errors.push({ account: group.account, message: error instanceof Error ? error.message : String(error) });
      }
    }));
    return ok({ tasks, missing, errors });
  }
  if (path === "/google/tasks" && (req.method === "PATCH" || req.method === "POST")) {
    const body = await readJson(req);
    if (!isEmail2(body.account) || !isGoogleId(body.listId))
      return { status: 400, body: { error: "account and listId are required" } };
    if (body.due !== undefined && body.due !== null && !isDateKey(body.due))
      return { status: 400, body: { error: "due must be a date or null" } };
    if (body.notes !== undefined && (typeof body.notes !== "string" || body.notes.length > 8192))
      return { status: 400, body: { error: "notes must be text, at most 8192 characters (as Google Tasks keeps)" } };
    if (body.title !== undefined && (typeof body.title !== "string" || !body.title.trim() || body.title.length > 1024))
      return { status: 400, body: { error: "title must be 1 to 1024 characters" } };
    if (req.method === "PATCH") {
      if (!isGoogleId(body.id))
        return { status: 400, body: { error: "id is required" } };
      if (body.completed !== undefined && typeof body.completed !== "boolean")
        return { status: 400, body: { error: "completed must be true or false" } };
      const patch = { ...body.completed !== undefined ? { completed: body.completed } : {}, ...body.due !== undefined ? { due: body.due } : {}, ...body.title !== undefined ? { title: body.title.trim() } : {}, ...body.notes !== undefined ? { notes: body.notes } : {} };
      const task = await googleData.updateTask(body.account, body.listId, body.id, patch);
      googleDueTasks.forget();
      return ok({ task });
    }
    if (typeof body.title !== "string")
      return { status: 400, body: { error: "title is required" } };
    if (body.parent !== undefined && body.parent !== null && !isGoogleId(body.parent) || body.previous !== undefined && body.previous !== null && !isGoogleId(body.previous))
      return { status: 400, body: { error: "parent and previous must be task ids" } };
    const task = await googleData.createTask(body.account, body.listId, { title: body.title.trim(), ...body.notes ? { notes: body.notes } : {}, ...body.due ? { due: body.due } : {}, parent: body.parent ?? null, previous: body.previous ?? null });
    googleDueTasks.forget();
    return ok({ task });
  }
  if (path === "/google/mail" && req.method === "GET") {
    const email = url.searchParams.get("account");
    const query = url.searchParams.get("q") ?? "in:inbox";
    const pageToken = url.searchParams.get("pageToken") ?? undefined;
    if (!isEmail2(email) || query.length > 500 || pageToken !== undefined && pageToken.length > 500)
      return { status: 400, body: { error: "account is required, and the search must be shorter" } };
    return ok(await googleData.mail(email, query, pageToken));
  }
  return null;
};
var readJson = (req) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      reject(new Error("request body too large"));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      resolve(text ? JSON.parse(text) : {});
    } catch {
      reject(new Error("request body is not JSON"));
    }
  });
  req.on("error", reject);
});
var server = http2.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (url.pathname === "/health" && req.method === "GET") {
      json(res, 200, { ok: true, version: planner.state.version, today: planner.today() });
      return;
    }
    if (url.pathname === "/state" && req.method === "GET") {
      json(res, 200, snapshot());
      return;
    }
    if (url.pathname === "/github/status" && req.method === "GET") {
      json(res, 200, await github.status());
      return;
    }
    if (url.pathname === "/github/list" && req.method === "GET") {
      const kind = url.searchParams.get("kind") ?? "assigned";
      if (!(kind in LISTS)) {
        json(res, 400, { error: "kind must be assigned, review or mine" });
        return;
      }
      try {
        json(res, 200, { items: await github.list(kind) });
      } catch (error) {
        json(res, 502, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (url.pathname === "/github/items" && req.method === "POST") {
      const body = await readJson(req);
      const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === "string" && /^[A-Za-z0-9_=-]{1,100}$/.test(id)) : [];
      try {
        json(res, 200, { items: await github.items(ids) });
      } catch (error) {
        json(res, 502, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (url.pathname === "/github/pulls" && req.method === "POST") {
      const body = await readJson(req);
      const runs = Array.isArray(body.runs) ? body.runs.filter(isLookup).slice(0, PULL_LOOKUPS_PER_REQUEST) : [];
      const results = await mapLimited2(runs, 4, async (run) => {
        try {
          return { runId: run.runId, pullRequest: run.url ? await github.pullRequestAt(run.url) : run.branch ? await github.pullRequestFor(run.branch, run.directories) : null };
        } catch (error) {
          return { runId: run.runId, pullRequest: null, error: error instanceof Error ? error.message : String(error) };
        }
      });
      json(res, 200, { results });
      return;
    }
    if (url.pathname === "/agents" || url.pathname.startsWith("/agents/")) {
      const answer = await agentRoute(req, url, { configDir: opencodeConfig, info: opencodeInfo, commands: agentCommands, readJson });
      if (answer) {
        json(res, answer.status, answer.body);
        return;
      }
    }
    if (url.pathname.startsWith("/google/")) {
      try {
        const answer = await googleRoute(req, url);
        if (answer) {
          json(res, answer.status, answer.body);
          return;
        }
      } catch (error) {
        if (error instanceof GoogleError) {
          json(res, error.status, { error: error.message });
          return;
        }
        throw error;
      }
    }
    if (url.pathname.startsWith("/linear/")) {
      try {
        if (url.pathname === "/linear/workspaces" && req.method === "GET") {
          json(res, 200, { workspaces: await linearWorkspaces.list() });
          return;
        }
        if (url.pathname === "/linear/workspaces" && req.method === "POST") {
          const body = await readJson(req);
          if (typeof body.key !== "string") {
            json(res, 400, { error: "key must be a string" });
            return;
          }
          json(res, 200, { workspace: await linearWorkspaces.add(body.key) });
          return;
        }
        const one = /^\/linear\/workspaces\/([A-Za-z0-9_-]{1,100})$/.exec(url.pathname);
        if (one && req.method === "DELETE") {
          json(res, 200, { removed: await linearWorkspaces.remove(one[1]) });
          return;
        }
        if (url.pathname === "/linear/graphql" && req.method === "POST") {
          const body = await readJson(req);
          if (typeof body.workspaceId !== "string" || typeof body.query !== "string") {
            json(res, 400, { error: "workspaceId and query must be strings" });
            return;
          }
          json(res, 200, await linearWorkspaces.graphql(body.workspaceId, body.query, body.variables ?? {}));
          return;
        }
      } catch (error) {
        if (error instanceof WorkspaceError) {
          json(res, error.status, { error: error.message });
          return;
        }
        throw error;
      }
    }
    if (url.pathname === "/sync") {
      if (req.method === "GET") {
        json(res, 200, sync.status());
        return;
      }
      if (req.method === "PUT") {
        const body = await readJson(req);
        if (body.remote !== null && typeof body.remote !== "string") {
          json(res, 400, { error: "remote must be a string or null" });
          return;
        }
        try {
          json(res, 200, await sync.setRemote(body.remote));
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      if (req.method === "POST") {
        const done = sync.run().catch((error) => ({ ...sync.status(), lastError: error instanceof Error ? error.message : String(error) }));
        const status = await Promise.race([done, new Promise((resolve) => setTimeout(() => resolve(sync.status()), SYNC_ANSWER_MS).unref?.())]);
        json(res, 200, { status, ...snapshot() });
        syncAgentCommands();
        return;
      }
    }
    if (url.pathname === "/calendar" && req.method === "GET") {
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      if (!isDateKey(from) || !isDateKey(to) || daysBetween(from, to) < 0 || daysBetween(from, to) > 62) {
        json(res, 400, { error: "from and to must be dates at most 62 days apart" });
        return;
      }
      const zone = planner.state.settings.timezone ?? "UTC";
      const refresh = url.searchParams.get("refresh") === "1";
      const calendars = Object.values(planner.state.calendars);
      const timeMin = instantAt(from, 0, zone);
      const timeMax = instantAt(addDays(to, 1), 0, zone);
      const taskAccounts = planner.state.settings.googleTasksOnCalendar ? (await google.status()).accounts.filter((account) => account.features.includes("tasks")).map((account) => account.email) : [];
      const [feed, fromGoogle, due, deadlines] = await Promise.all([
        feeds.eventsFor(calendars.filter((calendar) => !calendar.google), from, to, zone, refresh),
        googleCalendars.read(calendars, timeboxes.calendarsFor(planner.state, timeMin, timeMax), timeMin, timeMax, zone, refresh),
        googleDueTasks.read(taskAccounts, from, to, refresh),
        googleDueTasks.byIds(deadlineGroups(planner.state.googleTasks, taskAccounts, from, to), refresh)
      ]);
      const dueEvents = due.items.flatMap((item) => item.due ? [dueTaskEvent({ ...item, due: item.due }, zone)] : []);
      json(res, 200, {
        events: [...feed.events, ...fromGoogle.events, ...dueEvents].sort((a, b) => a.start.localeCompare(b.start)),
        deadlineTasks: deadlines.items,
        errors: [...feed.errors, ...fromGoogle.errors, ...[...due.errors, ...deadlines.errors].map((message) => ({ calendarId: GOOGLE_TASKS_CALENDAR, message }))]
      });
      if (fromGoogle.reads.size)
        timeboxes.reconcile(fromGoogle.reads, timeMin, timeMax).catch((error) => log(`Google Calendar: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (url.pathname === "/calendar/search" && req.method === "GET") {
      const query = (url.searchParams.get("q") ?? "").trim();
      if (!query || query.length > 200) {
        json(res, 400, { error: "q must be 1-200 characters" });
        return;
      }
      const zone = planner.state.settings.timezone ?? "UTC";
      const today = todayIn(zone);
      const [from, to] = [addDays(today, -366), addDays(today, 731)];
      const [timeMin, timeMax] = [instantAt(from, 0, zone), instantAt(addDays(to, 1), 0, zone)];
      const shown = Object.values(planner.state.calendars).filter((calendar) => calendar.visible);
      const needle = query.toLocaleLowerCase();
      const errors = [];
      let more = false;
      const [feed, ...fromGoogle] = await Promise.all([
        feeds.eventsFor(shown.filter((calendar) => !calendar.google), from, to, zone),
        ...shown.filter((calendar) => calendar.google).map((calendar) => googleData.searchEvents(calendar.google.account, calendar.google.calendarId, query, timeMin, timeMax, zone, calendar.id).catch((error) => {
          errors.push({ calendarId: calendar.id, message: error instanceof Error ? error.message : String(error) });
          return { events: [], more: false };
        }))
      ]);
      errors.push(...feed.errors);
      const events = feed.events.filter((event) => `${event.title}
${event.location}`.toLocaleLowerCase().includes(needle));
      for (const found of fromGoogle) {
        events.push(...found.events);
        more ||= found.more;
      }
      json(res, 200, { events: events.sort((a, b) => a.start.localeCompare(b.start)), from, to, more, errors });
      return;
    }
    if (url.pathname === "/activity" && req.method === "GET") {
      const taskId = url.searchParams.get("task") ?? "";
      json(res, 200, { events: planner.activity(taskId) });
      return;
    }
    if (url.pathname === "/commands" && req.method === "POST") {
      const body = await readJson(req);
      if (!Array.isArray(body.commands)) {
        json(res, 400, { error: "commands must be an array" });
        return;
      }
      await sync.idle();
      const result = planner.execute(body.commands);
      if (!result.ok) {
        json(res, 400, { error: result.error, index: result.index });
        return;
      }
      json(res, 200, { applied: result.applied, ...snapshot() });
      syncAgentCommands();
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});
var shutdown = async () => {
  server.close();
  await Promise.race([Promise.all([timeboxes.settled(), series.settled()]), new Promise((resolve) => setTimeout(resolve, 3000))]);
  await store.flush();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
server.listen(port, "127.0.0.1");
