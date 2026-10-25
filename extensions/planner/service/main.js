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
var DEFAULT_SETTINGS = {
  timezone: null,
  workloadMinutes: 6 * 60,
  archiveAfterRollovers: 7,
  weekStartsOn: 1,
  plannedAsActual: true,
  workdayStart: 9 * 60,
  workdayEnd: 18 * 60
};
var emptyState = () => ({
  version: 0,
  tasks: {},
  channels: {},
  entries: {},
  timer: null,
  blocks: {},
  calendars: {},
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
var isLive = (task) => !task.deletedAt && !task.archivedAt;
var byPosition = (a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt);
var samePlacement = (a, b) => a.kind === "day" ? b.kind === "day" && a.date === b.date : b.kind === "backlog" && a.bucket === b.bucket;
var tasksIn = (state, placement) => Object.values(state.tasks).filter((task) => isLive(task) && samePlacement(task.placement, placement)).sort(byPosition);
var tasksForDay = (state, date) => tasksIn(state, { kind: "day", date });
var entryIndex = new WeakMap;

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
var applyInto = (state, event) => {
  state.version += 1;
  switch (event.type) {
    case "task.created": {
      const input = event.task;
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
        createdAt: event.at,
        updatedAt: event.at,
        channelId: input.channelId ?? null,
        subtasks: [],
        source: input.source ?? null
      };
      return;
    }
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
      return;
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
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!/nothing to commit/.test(text)) {
        this.lastError = text.slice(0, 500);
        this.log(`git commit failed: ${this.lastError}`);
      }
    }
  }
  git(args) {
    const run = () => new Promise((resolve, reject) => {
      execFile("git", ["-c", "user.name=OpenChamber Planner", "-c", "user.email=planner@localhost", "-c", "commit.gpgsign=false", ...args], { cwd: this.dir, timeout: 30000 }, (error, stdout, stderr) => error ? reject(new Error(`${error.message}
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
var PATCH_FIELDS = ["title", "notes", "plannedMinutes", "priority", "dueDate", "channelId", "subtasks"];
var SERVICE_ONLY_TYPES = new Set(["tasks.rolledOver"]);
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
var isSource = (value) => isRecord(value) && (value.kind === "linear" || value.kind === "github") && typeof value.id === "string" && typeof value.key === "string" && typeof value.url === "string";
var PRIORITY_VALUES = new Set(["urgent", "high", "medium", "low"]);
var isPriority = (value) => value === null || typeof value === "string" && PRIORITY_VALUES.has(value);
var isColor = (value) => typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
var isChannelName = (value) => typeof value === "string" && /^[\p{L}\p{N}_-]{1,40}$/u.test(value);
var validatePatch = (patch, channels) => {
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
    else if (key === "subtasks" && !isSubtasks(value))
      return "subtasks are invalid";
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
    else if (!["timezone", "workloadMinutes", "archiveAfterRollovers", "weekStartsOn", "plannedAsActual", "workdayStart", "workdayEnd"].includes(key))
      return `unknown setting ${key}`;
  }
  return null;
};
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
      return null;
    }
    case "task.updated":
      return needTask() ?? validatePatch(command.patch, channels);
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

// src/domain/rollover.ts
var planRollover = (state, today) => {
  const stale = Object.values(state.tasks).filter((task) => !task.deletedAt && !task.archivedAt && !task.completedAt && task.placement.kind === "day" && task.placement.date < today).sort((a, b) => dayOf(a).localeCompare(dayOf(b)) || a.position - b.position);
  if (stale.length === 0)
    return null;
  const threshold = state.settings.archiveAfterRollovers;
  const archived = [];
  const carried = [];
  for (const task of stale) {
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
  return { type: "tasks.rolledOver", date: today, moved, archived };
};
var dayOf = (task) => task.placement.kind === "day" ? task.placement.date : "";

// src/domain/activity.ts
var touchesTask = (event, taskId) => {
  if (event.type === "task.created")
    return event.task.id === taskId;
  if (event.type === "tasks.rolledOver")
    return event.moved.some((item) => item.taskId === taskId) || event.archived.includes(taskId);
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
    case "tasks.rolledOver":
      return `Roll over ${event.moved.length} tasks to ${event.date}${event.archived.length ? `, archive ${event.archived.length}` : ""}`;
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
    case "calendar.added":
      return `Subscribe to calendar: ${event.calendar.name}`;
    case "calendar.updated":
      return "Edit calendar";
    case "calendar.removed":
      return "Remove calendar";
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
  snapshot() {
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
var daysInMonth = (year, month) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
var keyOf = (year, month, day) => `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
var nthWeekdayOfMonth = (year, month, day, n) => {
  const total = daysInMonth(year, month);
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
              for (let d = 1;d <= daysInMonth(year, month); d++)
                if (new Date(Date.UTC(year, month, d)).getUTCDay() === day)
                  candidates.push(keyOf(year, month, d));
            }
          }
        } else {
          for (const value of monthDays.length ? monthDays : [startDay]) {
            const total = daysInMonth(year, month);
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
        if (startDay <= daysInMonth(year, month))
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

// service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var BODY_LIMIT = 1e6;
var dir = process.env.PLANNER_DATA_DIR || join3(homedir(), ".local", "share", "openchamber-planner", "data");
var store = new EventStore({ dir, log: (message) => console.error(`[planner] ${message}`) });
await store.init();
var planner = new Planner(store);
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
      json(res, 200, { ok: true, version: planner.state.version });
      return;
    }
    if (url.pathname === "/state" && req.method === "GET") {
      json(res, 200, planner.snapshot());
      return;
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
      const result = planner.execute(body.commands);
      if (!result.ok) {
        json(res, 400, { error: result.error, index: result.index });
        return;
      }
      json(res, 200, { applied: result.applied, ...planner.snapshot() });
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
