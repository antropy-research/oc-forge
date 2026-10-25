// service/main.ts
import http from "node:http";
import { homedir } from "node:os";
import { join as join2 } from "node:path";

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
  plannedAsActual: true
};
var emptyState = () => ({
  version: 0,
  tasks: {},
  channels: {},
  entries: {},
  timer: null,
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
var daysBetween = (a, b) => Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86400000);

// src/domain/selectors.ts
var isLive = (task) => !task.deletedAt && !task.archivedAt;
var byPosition = (a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt);
var samePlacement = (a, b) => a.kind === "day" ? b.kind === "day" && a.date === b.date : b.kind === "backlog" && a.bucket === b.bucket;
var tasksIn = (state, placement) => Object.values(state.tasks).filter((task) => isLive(task) && samePlacement(task.placement, placement)).sort(byPosition);
var tasksForDay = (state, date) => tasksIn(state, { kind: "day", date });
var entryIndex = new WeakMap;

// src/domain/reducer.ts
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
    case "task.moved":
      touch(state, event.taskId, event.at, (task) => ({
        ...task,
        placement: event.placement,
        position: event.position,
        rolloverCount: samePlacement(task.placement, event.placement) ? task.rolloverCount : 0,
        archivedAt: null
      }));
      return;
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
  const next = { ...state, tasks: { ...state.tasks }, channels: { ...state.channels }, entries: { ...state.entries }, settings: { ...state.settings } };
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
    else if (!["timezone", "workloadMinutes", "archiveAfterRollovers", "weekStartsOn", "plannedAsActual"].includes(key))
      return `unknown setting ${key}`;
  }
  return null;
};
var isInstant = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value);
var MAX_ENTRY_MS = 24 * 60 * 60 * 1000;
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

// service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var BODY_LIMIT = 1e6;
var dir = process.env.PLANNER_DATA_DIR || join2(homedir(), ".local", "share", "openchamber-planner", "data");
var store = new EventStore({ dir, log: (message) => console.error(`[planner] ${message}`) });
await store.init();
var planner = new Planner(store);
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
