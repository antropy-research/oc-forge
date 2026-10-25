// Calendar feeds: fetch ICS subscriptions, cache them, expand occurrences for a range.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandEvents, parseIcs, type CalendarEvent, type VEvent } from '../src/domain/ics.ts';
import type { CalendarSubscription, DateKey } from '../src/domain/types.ts';

const TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 15_000;
const MAX_CHARS = 10_000_000;

export interface FeedResult {
  events: CalendarEvent[];
  errors: { calendarId: string; message: string }[];
}

type Fetcher = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class CalendarFeeds {
  private readonly cache = new Map<string, { url: string; fetchedAt: number; events: VEvent[] }>();

  constructor(private readonly cacheDir: string, private readonly fetcher: Fetcher = fetch as unknown as Fetcher) {
    mkdirSync(cacheDir, { recursive: true });
  }

  async eventsFor(calendars: readonly CalendarSubscription[], from: DateKey, to: DateKey, zone: string, refresh = false): Promise<FeedResult> {
    const result: FeedResult = { events: [], errors: [] };
    await Promise.all(
      calendars.filter((calendar) => calendar.visible).map(async (calendar) => {
        try {
          const events = await this.load(calendar, refresh);
          result.events.push(...expandEvents(events, calendar.id, from, to, zone));
        } catch (error) {
          result.errors.push({ calendarId: calendar.id, message: error instanceof Error ? error.message : String(error) });
        }
      }),
    );
    result.events.sort((a, b) => a.start.localeCompare(b.start));
    return result;
  }

  private async load(calendar: CalendarSubscription, refresh: boolean): Promise<VEvent[]> {
    const hit = this.cache.get(calendar.id);
    if (hit && hit.url === calendar.url && !refresh && Date.now() - hit.fetchedAt < TTL_MS) return hit.events;
    const copy = join(this.cacheDir, `${calendar.id}.ics`);
    let text: string;
    try {
      text = await this.fetchText(calendar.url);
      writeFileSync(copy, text);
    } catch (error) {
      // Offline or the feed is down: keep showing the last good copy.
      if (hit && hit.url === calendar.url) return hit.events;
      if (!existsSync(copy)) throw error;
      text = readFileSync(copy, 'utf8');
    }
    const events = parseIcs(text);
    this.cache.set(calendar.id, { url: calendar.url, fetchedAt: Date.now(), events });
    return events;
  }

  private async fetchText(url: string): Promise<string> {
    const target = url.replace(/^webcal:/i, 'https:');
    let text: string;
    if (/^file:/i.test(target)) {
      text = readFileSync(fileURLToPath(target), 'utf8');
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await this.fetcher(target, { signal: controller.signal, headers: { accept: 'text/calendar, */*' } });
        if (!response.ok) throw new Error(`calendar feed answered HTTP ${response.status}`);
        text = await response.text();
      } finally {
        clearTimeout(timer);
      }
    }
    if (text.length > MAX_CHARS) throw new Error('calendar feed is too large');
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('not an iCalendar feed');
    return text;
  }
}
