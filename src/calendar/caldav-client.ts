import { createDAVClient } from 'tsdav';
import type { ResolvedSection } from '../config/config-resolver.js';
import type { AuthProvider } from '../auth/auth-provider.js';
import { DEFAULT_TIMEOUT_MS, withTimeout } from '../core/http.js';
import {
  buildEventICal,
  parseEvents,
  setAttendeePartstat,
  type EventInput,
  type EventSummary,
  type Partstat,
} from './ical.js';

export interface CalendarInfo {
  url: string;
  displayName: string;
  ctag?: string;
}

interface DavCalendar {
  url: string;
  displayName?: string | Record<string, unknown>;
  ctag?: string;
}

interface DavObject {
  url: string;
  etag?: string;
  data?: string;
}

/** Narrow subset of the tsdav client we depend on (keeps tests decoupled). */
export interface TsdavBackend {
  fetchCalendars(): Promise<DavCalendar[]>;
  fetchCalendarObjects(params: {
    calendar: DavCalendar;
    timeRange?: { start: string; end: string };
    objectUrls?: string[];
  }): Promise<DavObject[]>;
  createCalendarObject(params: {
    calendar: DavCalendar;
    iCalString: string;
    filename: string;
  }): Promise<{ ok: boolean; status: number }>;
  updateCalendarObject(params: { calendarObject: DavObject }): Promise<{ ok: boolean; status: number }>;
  deleteCalendarObject(params: { calendarObject: DavObject }): Promise<{ ok: boolean; status: number }>;
}

export type TsdavBackendFactory = (
  section: ResolvedSection,
  authHeader: string,
) => Promise<TsdavBackend>;

/** Build a tsdav-backed factory whose every request times out after `timeoutMs`. */
export function makeTsdavBackendFactory(timeoutMs: number = DEFAULT_TIMEOUT_MS): TsdavBackendFactory {
  const fetchFn = withTimeout(fetch, timeoutMs);
  return async (section, authHeader) => {
    const client = await createDAVClient({
      serverUrl: `https://${section.server}`,
      credentials: {},
      authMethod: 'Custom',
      authFunction: async () => ({ Authorization: authHeader }),
      defaultAccountType: 'caldav',
      fetch: fetchFn,
    });
    return client as unknown as TsdavBackend;
  };
}

/** Default backend: a tsdav client authenticated with our Authorization header. */
export const defaultTsdavBackendFactory: TsdavBackendFactory = makeTsdavBackendFactory();

export class CalDavClient {
  constructor(
    private readonly section: ResolvedSection,
    private readonly authProvider: AuthProvider,
    private readonly backendFactory: TsdavBackendFactory = defaultTsdavBackendFactory,
  ) {}

  async listCalendars(): Promise<CalendarInfo[]> {
    const backend = await this.backend();
    const calendars = await backend.fetchCalendars();
    return calendars.map((c) => ({
      url: c.url,
      displayName: normalizeName(c.displayName) ?? c.url,
      ctag: c.ctag,
    }));
  }

  async listEvents(calendarUrl: string, start: string, end: string): Promise<EventSummary[]> {
    const backend = await this.backend();
    const calendar = await this.findCalendar(backend, calendarUrl);
    const objects = await backend.fetchCalendarObjects({
      calendar,
      timeRange: { start, end },
    });
    return objects.flatMap((o) =>
      o.data ? withObjectRefs(parseEvents(o.data, { start, end }), o) : [],
    );
  }

  async createEvent(calendarUrl: string, input: EventInput): Promise<{ uid: string; url: string }> {
    const backend = await this.backend();
    const calendar = await this.findCalendar(backend, calendarUrl);
    const { uid, ical } = buildEventICal(input);
    const filename = `${uid}.ics`;
    const res = await backend.createCalendarObject({ calendar, iCalString: ical, filename });
    assertOk(res, 'create event');
    return { uid, url: joinUrl(calendar.url, filename) };
  }

  async updateEvent(objectUrl: string, input: EventInput, etag?: string): Promise<void> {
    const backend = await this.backend();
    const { ical } = buildEventICal(input);
    const res = await backend.updateCalendarObject({
      calendarObject: { url: objectUrl, data: ical, etag },
    });
    assertOk(res, 'update event');
  }

  /**
   * RSVP to an invitation: rewrite this account's ATTENDEE PARTSTAT and PUT the
   * event back. The DAV server emits the iTIP reply to the organizer.
   */
  async respondToEvent(calendarUrl: string, objectUrl: string, partstat: Partstat): Promise<void> {
    const backend = await this.backend();
    const calendar = await this.findCalendar(backend, calendarUrl);
    const objects = await backend.fetchCalendarObjects({ calendar, objectUrls: [objectUrl] });
    const object = objects.find((o) => o.url === objectUrl && o.data) ?? objects.find((o) => o.data);
    if (!object?.data) {
      throw new Error(`Event object not found: ${objectUrl}`);
    }
    const updated = setAttendeePartstat(object.data, this.section.auth.user, partstat);
    const res = await backend.updateCalendarObject({
      calendarObject: { url: object.url, data: updated, etag: object.etag },
    });
    assertOk(res, 'respond to event');
  }

  async deleteEvent(objectUrl: string, etag?: string): Promise<void> {
    const backend = await this.backend();
    const res = await backend.deleteCalendarObject({
      calendarObject: { url: objectUrl, etag },
    });
    assertOk(res, 'delete event');
  }

  private async backend(): Promise<TsdavBackend> {
    const header = await this.authProvider.getDavAuthHeader();
    return this.backendFactory(this.section, header);
  }

  private async findCalendar(backend: TsdavBackend, calendarUrl: string): Promise<DavCalendar> {
    const calendars = await backend.fetchCalendars();
    const match =
      calendars.find((c) => c.url === calendarUrl) ??
      calendars.find((c) => normalizeName(c.displayName) === calendarUrl);
    if (!match) {
      throw new Error(
        `Calendar "${calendarUrl}" not found. Available: ${calendars.map((c) => c.url).join(', ')}`,
      );
    }
    return match;
  }
}

function normalizeName(name: string | Record<string, unknown> | undefined): string | undefined {
  if (typeof name === 'string') return name;
  return undefined;
}

function withObjectRefs(events: EventSummary[], obj: DavObject): (EventSummary & { objectUrl: string; etag?: string })[] {
  return events.map((e) => ({ ...e, objectUrl: obj.url, etag: obj.etag }));
}

function assertOk(res: { ok: boolean; status: number }, action: string): void {
  if (!res.ok) {
    throw new Error(`CalDAV ${action} failed (${res.status}).`);
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}/${path}`;
}
