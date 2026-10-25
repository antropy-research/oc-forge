// service/main.ts
import http from "node:http";
import { homedir } from "node:os";
import { dirname, join as join3 } from "node:path";

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
var RITUALS = ["planning", "shutdown", "highlights", "weeklyPlanning", "weeklyReview"];
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
  suggestFromHistory: true,
  pomodoroMinutes: 25,
  breakMinutes: 5
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
  settings: { ...DEFAULT_SETTINGS }
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
      next = { ...next, placement: { kind: "day", date }, position: last + 1024, rolloverCount: 0, archivedAt: null };
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
        archivedAt: null
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
      touch(state, event.taskId, event.at, (task) => ({ ...task, source: event.source, ...event.title !== undefined ? { title: event.title.trim() } : {} }));
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
    settings: { ...state.settings }
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

// src/domain/events.ts
var PATCH_FIELDS = ["title", "notes", "plannedMinutes", "priority", "dueDate", "channelId", "folderId", "objectiveId", "subtasks", "source"];
var SERVICE_ONLY_TYPES = new Set(["tasks.rolledOver", "tasks.recurred"]);
var TITLE_MAX = 500;
var NOTES_MAX = 40000;
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var isId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
var isMinutes = (value) => value === null || typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 24 * 60 * 7;
var isTitle = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= TITLE_MAX;
var BUCKET_IDS = new Set(BACKLOG_BUCKETS.map((bucket) => bucket.id));
var isPlacement = (value) => {
  if (!isRecord(value))
    return false;
  if (value.kind === "day")
    return isDateKey(value.date);
  if (value.kind === "backlog")
    return typeof value.bucket === "string" && BUCKET_IDS.has(value.bucket);
  return false;
};
var isSubtasks = (value) => Array.isArray(value) && value.length <= 200 && value.every((item) => isRecord(item) && isId(item.id) && isTitle(item.title) && typeof item.done === "boolean");
var isShortText = (value, max) => typeof value === "string" && value.length <= max;
var isSource = (value) => isRecord(value) && (value.kind === "linear" || value.kind === "github") && isShortText(value.id, 200) && value.id.length > 0 && isShortText(value.key, 100) && isShortText(value.url, 2000) && /^https:\/\//.test(value.url) && (value.title === undefined || isShortText(value.title, TITLE_MAX)) && (value.teamId === undefined || isShortText(value.teamId, 200)) && (value.status === undefined || isRecord(value.status) && isShortText(value.status.name, 100) && isShortText(value.status.type, 40) && isShortText(value.status.color, 40));
var PRIORITY_VALUES = new Set(["urgent", "high", "medium", "low"]);
var isPriority = (value) => value === null || typeof value === "string" && PRIORITY_VALUES.has(value);
var isColor = (value) => typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
var isChannelName = (value) => typeof value === "string" && /^[\p{L}\p{N}_-]{1,40}$/u.test(value);
var validatePatch = (patch, channels, objectives, folders) => {
  if (!isRecord(patch))
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
  if (!isRecord(patch))
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
var validateSettingsPatch = (patch) => {
  if (!isRecord(patch))
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
    else if (key === "suggestFromHistory" && typeof value !== "boolean")
      return "suggestFromHistory must be true or false";
    else if ((key === "pomodoroMinutes" || key === "breakMinutes") && !(Number.isInteger(value) && value >= 1 && value <= 180))
      return `${key} must be 1-180`;
    else if (!["timezone", "workloadMinutes", "archiveAfterRollovers", "weekStartsOn", "plannedAsActual", "workdayStart", "workdayEnd", "linearOnComplete", "linearOnPlan", "linearImportCompletion", "suggestFromHistory", "pomodoroMinutes", "breakMinutes"].includes(key))
      return `unknown setting ${key}`;
  }
  return null;
};
var isFolderName = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 60;
var isSessionRef = (value) => value === null || isRecord(value) && isShortText(value.sessionId, 200) && value.sessionId.length > 0 && isShortText(value.title, 500) && (value.directory === null || isShortText(value.directory, 1024));
var isRunShape = (value) => {
  if (!isRecord(value) || !isId(value.id))
    return "run needs an id";
  if (!(isShortText(value.sessionId, 200) && value.sessionId.length > 0))
    return "run needs a session";
  if (!(value.projectId === null || isShortText(value.projectId, 1024)))
    return "projectId is invalid";
  if (!(value.directory === null || isShortText(value.directory, 1024)))
    return "directory is invalid";
  if (!(value.worktree === null || isRecord(value.worktree) && isShortText(value.worktree.directory, 1024) && (value.worktree.branch === null || isShortText(value.worktree.branch, 200))))
    return "worktree is invalid";
  return isShortText(value.title, TITLE_MAX) ? null : "title is invalid";
};
var isRule = (value) => {
  if (!isRecord(value))
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
  if (!isRecord(template))
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
  if (!isRecord(fields))
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
        if (!isRecord(item) || !isId(item.id) || !(typeof item.text === "string" && item.text.trim() && item.text.length <= 1000) || typeof item.starred !== "boolean" || !(item.taskId === null || isId(item.taskId)) || !(item.hidden === undefined || typeof item.hidden === "boolean"))
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
  if (!isRecord(command))
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
      if (!isRecord(task) || !isId(task.id))
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
      return needTask();
    case "timer.started":
      return needTask();
    case "timer.stopped":
      return null;
    case "time.logged": {
      const entry = command.entry;
      if (!isRecord(entry) || !isId(entry.id))
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
      if (!isRecord(block) || !isId(block.id))
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
    case "calendar.added": {
      const calendar = command.calendar;
      if (!isRecord(calendar) || !isId(calendar.id))
        return "calendar needs an id";
      if (context.calendars[calendar.id])
        return "calendar id already exists";
      if (!(typeof calendar.name === "string" && calendar.name.trim() && calendar.name.length <= 80))
        return "calendar name must be 1-80 characters";
      if (!isFeedUrl(calendar.url))
        return "calendar URL must be http(s), webcal or file";
      return isColor(calendar.color) ? null : "color must be #rrggbb";
    }
    case "calendar.updated": {
      if (!(isId(command.calendarId) && context.calendars[command.calendarId]))
        return "unknown calendar";
      const patch = command.patch;
      if (!isRecord(patch))
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
      if (!isRecord(objective) || !isId(objective.id))
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
      if (!isRecord(patch))
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
      if (!isRecord(series) || !isId(series.id))
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
      if (!isRecord(patch))
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
      if (!isRecord(folder) || !isId(folder.id))
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
    case "ritual.saved":
      if (!RITUALS.includes(command.ritual))
        return "unknown ritual";
      if (!isDateKey(command.date))
        return "date must be a date";
      return validateRitualFields(command.ritual, command.fields);
    case "channel.created": {
      const channel = command.channel;
      if (!isRecord(channel) || !isId(channel.id))
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
var daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
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
      const total = daysInMonth(y, m);
      const wanted = rule.monthDay ?? sd;
      const target = wanted < 0 ? total + wanted + 1 : Math.min(wanted, total);
      return d === target;
    }
    case "yearly": {
      const [sy, sm, sd] = parts(startDate);
      const [y, m, d] = parts(date);
      return (y - sy) % interval === 0 && m === sm && d === Math.min(sd, daysInMonth(y, m));
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
      return `Start agent: ${titleOf(event.run.taskId)}`;
    case "run.outcome":
      return `Agent run ${event.outcome}`;
    case "run.reviewed":
      return `Review agent run: ${event.verdict}`;
    case "run.removed":
      return "Unlink agent run";
    case "channel.created":
      return `Add channel: ${event.channel.name}`;
    case "channel.updated":
      return `Edit channel: ${event.channelId}`;
    case "channel.deleted":
      return `Delete channel: ${event.channelId}`;
    case "settings.updated":
      return `Update settings: ${Object.keys(event.patch).join(", ")}`;
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
var WEEKDAY_CODES = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
var MAX_OCCURRENCES = 5000;
var daysInMonth2 = (year, month) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
var keyOf = (year, month, day) => `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
var nthWeekdayOfMonth = (year, month, day, n) => {
  const total = daysInMonth2(year, month);
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
      const days = byDay.length ? byDay.map((code) => WEEKDAY_CODES[code.slice(-2)]).filter((day) => day !== undefined) : [weekday(start.date)];
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
            const day = WEEKDAY_CODES[match[2]];
            const nth = match[1] ? Number(match[1]) : null;
            if (nth) {
              const date = nthWeekdayOfMonth(year, month, day, nth);
              if (date)
                candidates.push(date);
            } else {
              for (let d = 1;d <= daysInMonth2(year, month); d++)
                if (new Date(Date.UTC(year, month, d)).getUTCDay() === day)
                  candidates.push(keyOf(year, month, d));
            }
          }
        } else {
          for (const value of monthDays.length ? monthDays : [startDay]) {
            const total = daysInMonth2(year, month);
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
        if (startDay <= daysInMonth2(year, month))
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
var ghRunner = (args) => new Promise((resolve, reject) => {
  execFile2("gh", args, { timeout: 20000, maxBuffer: 8000000 }, (error, stdout, stderr) => {
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
var explain = (error) => {
  const failure = error;
  if (failure.code === "ENOENT")
    return "The GitHub CLI (gh) is not installed on the machine running OpenChamber.";
  const text = `${failure.stderr ?? ""} ${failure.message ?? ""}`;
  if (/auth login|not logged|authentication/i.test(text))
    return "Log in once with `gh auth login` on the machine running OpenChamber.";
  return text.trim().split(`
`)[0]?.slice(0, 300) || "gh failed";
};

class GitHubSource {
  run;
  constructor(run = ghRunner) {
    this.run = run;
  }
  async status() {
    try {
      const login = (await this.run(["api", "user", "--jq", ".login"])).trim();
      return { available: true, login: login || null, message: null };
    } catch (error) {
      return { available: false, login: null, message: explain(error) };
    }
  }
  async list(kind) {
    const out = await this.run(["api", "graphql", "-f", `query=${LIST_QUERY}`, "-f", `q=${LISTS[kind]}`]).catch((error) => {
      throw new Error(explain(error));
    });
    return parseNodes(JSON.parse(out).data?.search?.nodes ?? []);
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

// service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var BODY_LIMIT = 1e6;
var dir = process.env.PLANNER_DATA_DIR || join3(homedir(), ".local", "share", "openchamber-planner", "data");
var log = (message) => console.error(`[planner] ${message}`);
var sync = null;
var store = new EventStore({ dir, log, onCommit: () => sync?.schedule() });
await store.init();
var planner = new Planner(store);
sync = new SyncManager(store, planner, log);
await sync.init();
var snapshot = () => ({ ...planner.snapshot(), sync: sync.status() });
var github = new GitHubSource;
var feeds = new CalendarFeeds(join3(dirname(dir), "cache"));
var json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
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
var server = http.createServer(async (req, res) => {
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
        const status = await sync.run().catch((error) => ({ ...sync.status(), lastError: error instanceof Error ? error.message : String(error) }));
        json(res, 200, { status, ...snapshot() });
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
      json(res, 200, await feeds.eventsFor(Object.values(planner.state.calendars), from, to, zone, url.searchParams.get("refresh") === "1"));
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
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});
var shutdown = async () => {
  server.close();
  await store.flush();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
server.listen(port, "127.0.0.1");
