import { randomUUID } from 'node:crypto';
import ical from 'ical-generator';
import ICAL from 'ical.js';

export interface EventInput {
  uid?: string;
  summary: string;
  start: string; // ISO 8601
  end: string; // ISO 8601
  description?: string;
  location?: string;
  allDay?: boolean;
  organizer?: { name?: string; email: string };
  attendees?: { name?: string; email: string }[];
}

export interface EventSummary {
  uid: string;
  summary: string;
  start: string | null;
  end: string | null;
  location?: string;
  description?: string;
  organizer?: string;
  attendees?: string[];
}

export interface BusyPeriod {
  start: string;
  end: string;
  type: string;
}

/** Build a VCALENDAR/VEVENT iCal string for a calendar object PUT. */
export function buildEventICal(input: EventInput): { uid: string; ical: string } {
  const uid = input.uid ?? `${randomUUID()}@ox-mcp`;
  const cal = ical({ prodId: { company: 'ox-mcp', product: 'ox-mcp' } });
  cal.createEvent({
    id: uid,
    start: new Date(input.start),
    end: new Date(input.end),
    allDay: input.allDay ?? false,
    summary: input.summary,
    description: input.description,
    location: input.location,
    organizer: input.organizer
      ? { name: input.organizer.name ?? input.organizer.email, email: input.organizer.email }
      : undefined,
    attendees: input.attendees?.map((a) => ({ name: a.name, email: a.email })),
  });
  return { uid, ical: cal.toString() };
}

const MAX_OCCURRENCES = 10_000;

/**
 * Parse one VCALENDAR iCal string into VEVENT summaries.
 *
 * When `range` is given, recurring events (RRULE) are expanded client-side
 * into their actual instances within the range — honoring EXDATEs and
 * RECURRENCE-ID overrides — and non-overlapping events are dropped. Servers
 * return the recurrence *master* for any series with an instance in the
 * queried window, so without expansion the reported dates are wrong.
 */
export function parseEvents(
  icalString: string,
  range?: { start: string; end: string },
): EventSummary[] {
  const jcal = ICAL.parse(icalString);
  const comp = new ICAL.Component(jcal);
  const vevents = comp.getAllSubcomponents('vevent');
  const rangeStart = range ? new Date(range.start).getTime() : -Infinity;
  const rangeEnd = range ? new Date(range.end).getTime() : Infinity;

  const masters = vevents.filter((v) => !v.hasProperty('recurrence-id'));
  const overrides = vevents.filter((v) => v.hasProperty('recurrence-id'));
  const masterUids = new Set(masters.map((v) => new ICAL.Event(v).uid));

  const out: EventSummary[] = [];

  for (const vevent of masters) {
    const event = new ICAL.Event(vevent);
    for (const o of overrides) {
      const exception = new ICAL.Event(o);
      if (exception.uid === event.uid) event.relateException(exception);
    }

    if (!event.isRecurring() || !range) {
      const summary = toEventSummary(vevent, event);
      if (overlaps(summary, rangeStart, rangeEnd)) out.push(summary);
      continue;
    }

    const iter = event.iterator();
    let next: ICAL.Time | null;
    let guard = 0;
    while ((next = iter.next()) && guard++ < MAX_OCCURRENCES) {
      const occ = event.getOccurrenceDetails(next);
      const start = occ.startDate.toJSDate().getTime();
      const end = occ.endDate.toJSDate().getTime();
      if (end <= rangeStart) continue;
      if (start >= rangeEnd) break;
      out.push({
        ...toEventSummary(occ.item.component, occ.item),
        start: occ.startDate.toJSDate().toISOString(),
        end: occ.endDate.toJSDate().toISOString(),
      });
    }
  }

  // Overrides are emitted here when standalone (no master in this object) or
  // when no range was given (range expansion already covers related ones).
  for (const o of overrides) {
    const event = new ICAL.Event(o);
    if (range && masterUids.has(event.uid)) continue;
    const summary = toEventSummary(o, event);
    if (overlaps(summary, rangeStart, rangeEnd)) out.push(summary);
  }

  out.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));
  return out;
}

function toEventSummary(vevent: ICAL.Component, event: ICAL.Event): EventSummary {
  const attendees = vevent
    .getAllProperties('attendee')
    .map((p) => cleanCalAddress(String(p.getFirstValue())))
    .filter(Boolean);
  const organizerProp = vevent.getFirstProperty('organizer');
  return {
    uid: event.uid,
    summary: event.summary ?? '(no title)',
    start: event.startDate ? event.startDate.toJSDate().toISOString() : null,
    end: event.endDate ? event.endDate.toJSDate().toISOString() : null,
    location: event.location || undefined,
    description: event.description || undefined,
    organizer: organizerProp ? cleanCalAddress(String(organizerProp.getFirstValue())) : undefined,
    attendees: attendees.length ? attendees : undefined,
  };
}

function overlaps(summary: EventSummary, rangeStart: number, rangeEnd: number): boolean {
  const start = summary.start ? new Date(summary.start).getTime() : -Infinity;
  const end = summary.end ? new Date(summary.end).getTime() : start;
  return end > rangeStart && start < rangeEnd;
}

/** Parse a VFREEBUSY iCal response into busy periods. */
export function parseFreeBusy(icalString: string): BusyPeriod[] {
  const jcal = ICAL.parse(icalString);
  const comp = new ICAL.Component(jcal);
  const vfb = comp.name === 'vfreebusy' ? comp : comp.getFirstSubcomponent('vfreebusy');
  if (!vfb) return [];
  const periods: BusyPeriod[] = [];
  for (const prop of vfb.getAllProperties('freebusy')) {
    const fbType = String(prop.getParameter('fbtype') ?? 'BUSY');
    for (const value of prop.getValues()) {
      const period = value as { start?: { toJSDate(): Date }; end?: { toJSDate(): Date }; duration?: unknown };
      if (period?.start && period?.end) {
        periods.push({
          start: period.start.toJSDate().toISOString(),
          end: period.end.toJSDate().toISOString(),
          type: fbType,
        });
      }
    }
  }
  return periods;
}

/** Build a VFREEBUSY REQUEST for a scheduling-outbox POST (RFC 6638 §5). */
export function buildFreeBusyRequest(params: {
  organizer: string;
  attendees: string[];
  start: string;
  end: string;
}): string {
  const dt = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const uid = `${randomUUID()}@ox-mcp`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ox-mcp//EN',
    'METHOD:REQUEST',
    'BEGIN:VFREEBUSY',
    `UID:${uid}`,
    `DTSTAMP:${dt(new Date().toISOString())}`,
    `DTSTART:${dt(params.start)}`,
    `DTEND:${dt(params.end)}`,
    `ORGANIZER:mailto:${params.organizer}`,
    ...params.attendees.map((a) => `ATTENDEE:mailto:${a}`),
    'END:VFREEBUSY',
    'END:VCALENDAR',
  ];
  return `${lines.join('\r\n')}\r\n`;
}

export type Partstat = 'ACCEPTED' | 'DECLINED' | 'TENTATIVE';

/**
 * Rewrite the PARTSTAT of the attendee matching `email` in every VEVENT of the
 * iCal string. Throws when the email is not an attendee.
 */
export function setAttendeePartstat(icalString: string, email: string, partstat: Partstat): string {
  const jcal = ICAL.parse(icalString);
  const comp = new ICAL.Component(jcal);
  const target = email.toLowerCase();
  let found = false;
  for (const vevent of comp.getAllSubcomponents('vevent')) {
    for (const prop of vevent.getAllProperties('attendee')) {
      const address = cleanCalAddress(String(prop.getFirstValue() ?? '')).toLowerCase();
      if (address === target) {
        prop.setParameter('partstat', partstat);
        found = true;
      }
    }
  }
  if (!found) {
    throw new Error(`"${email}" is not an attendee of this event.`);
  }
  return comp.toString();
}

function cleanCalAddress(value: string): string {
  return value.replace(/^mailto:/i, '');
}
