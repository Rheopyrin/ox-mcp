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
    const url = await this.trustedObjectUrl(backend, objectUrl);
    const { ical } = buildEventICal(input);
    const res = await backend.updateCalendarObject({
      calendarObject: { url, data: ical, etag },
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
    const url = await this.trustedObjectUrl(backend, objectUrl);
    const objects = await backend.fetchCalendarObjects({ calendar, objectUrls: [url] });
    const object = objects.find((o) => o.url === url && o.data) ?? objects.find((o) => o.data);
    if (!object?.data) {
      throw new Error(`Event object not found: ${objectUrl}`);
    }
    const putUrl = await this.trustedObjectUrl(backend, object.url);
    const updated = setAttendeePartstat(object.data, this.section.auth.user, partstat);
    const res = await backend.updateCalendarObject({
      calendarObject: { url: putUrl, data: updated, etag: object.etag },
    });
    assertOk(res, 'respond to event');
  }

  async deleteEvent(objectUrl: string, etag?: string): Promise<void> {
    const backend = await this.backend();
    const url = await this.trustedObjectUrl(backend, objectUrl);
    const res = await backend.deleteCalendarObject({
      calendarObject: { url, etag },
    });
    assertOk(res, 'delete event');
  }

  private async backend(): Promise<TsdavBackend> {
    const header = await this.authProvider.getDavAuthHeader();
    return this.backendFactory(this.section, header);
  }

  /**
   * Resolve a calendar object URL and verify it points at this account's CalDAV
   * service before any authenticated request is sent to it.
   *
   * Object URLs arrive as tool arguments, i.e. they are model-controlled and can
   * be steered by prompt injection. tsdav attaches the account's Authorization
   * header to every request regardless of host, so an unchecked absolute URL
   * would hand the credentials to whatever host it names.
   *
   * Relative paths resolve against the configured server. Trusted origins are
   * the configured server plus any host the server itself lists calendars on
   * (some providers serve collections from a different host than discovery).
   * Only `https:` is accepted, so credentials never go out in cleartext.
   */
  private async trustedObjectUrl(backend: TsdavBackend, raw: string): Promise<string> {
    const serverOrigin = originOf(`https://${this.section.server}`);
    if (!serverOrigin) {
      throw new Error(`CalDAV server "${this.section.server}" is not a valid host.`);
    }
    let url: URL;
    try {
      url = new URL(raw, `${serverOrigin}/`);
    } catch {
      throw new Error(`Invalid calendar object URL: ${raw}`);
    }
    url.username = '';
    url.password = '';
    if (url.protocol === 'https:') {
      if (url.origin === serverOrigin) return url.href;
      const calendars = await backend.fetchCalendars();
      if (calendars.some((c) => originOf(c.url) === url.origin)) return url.href;
    }
    throw new Error(
      `Refusing to send CalDAV credentials to ${url.origin}: calendar object URLs must be on this ` +
        `account's CalDAV server (${serverOrigin}). Use an objectUrl returned by calendar_list_events.`,
    );
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

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
