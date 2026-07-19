import { describe, expect, it } from 'vitest';
import {
  buildEventICal,
  buildFreeBusyRequest,
  parseEvents,
  parseFreeBusy,
  setAttendeePartstat,
} from '../../src/calendar/ical.js';

describe('buildEventICal + parseEvents round-trip', () => {
  it('builds a VEVENT and parses it back', () => {
    const { uid, ical } = buildEventICal({
      summary: 'Standup',
      start: '2026-07-20T09:00:00Z',
      end: '2026-07-20T09:30:00Z',
      location: 'Room 1',
      description: 'Daily sync',
      organizer: { email: 'me@ex.com', name: 'Me' },
      attendees: [{ email: 'a@ex.com', name: 'A' }],
    });
    expect(ical).toContain('BEGIN:VEVENT');

    const events = parseEvents(ical);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.uid).toBe(uid);
    expect(e.summary).toBe('Standup');
    expect(e.location).toBe('Room 1');
    expect(new Date(e.start!).toISOString()).toBe('2026-07-20T09:00:00.000Z');
    expect(new Date(e.end!).toISOString()).toBe('2026-07-20T09:30:00.000Z');
    expect(e.attendees).toContain('a@ex.com');
    expect(e.organizer).toBe('me@ex.com');
  });
});

describe('parseFreeBusy', () => {
  it('extracts busy periods from a VFREEBUSY', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//test//EN',
      'BEGIN:VFREEBUSY',
      'DTSTART:20260720T000000Z',
      'DTEND:20260721T000000Z',
      'FREEBUSY;FBTYPE=BUSY:20260720T090000Z/20260720T093000Z',
      'END:VFREEBUSY',
      'END:VCALENDAR',
    ].join('\r\n');

    const busy = parseFreeBusy(ics);
    expect(busy).toHaveLength(1);
    expect(busy[0].type).toBe('BUSY');
    expect(new Date(busy[0].start).toISOString()).toBe('2026-07-20T09:00:00.000Z');
    expect(new Date(busy[0].end).toISOString()).toBe('2026-07-20T09:30:00.000Z');
  });

  it('returns empty when no VFREEBUSY present', () => {
    const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nEND:VCALENDAR';
    expect(parseFreeBusy(ics)).toEqual([]);
  });
});

describe('buildFreeBusyRequest', () => {
  it('emits a VFREEBUSY REQUEST with organizer and attendees', () => {
    const req = buildFreeBusyRequest({
      organizer: 'me@ex.com',
      attendees: ['a@ex.com', 'b@ex.com'],
      start: '2026-07-20T00:00:00Z',
      end: '2026-07-21T00:00:00Z',
    });
    expect(req).toContain('METHOD:REQUEST');
    expect(req).toContain('BEGIN:VFREEBUSY');
    expect(req).toContain('ORGANIZER:mailto:me@ex.com');
    expect(req).toContain('ATTENDEE:mailto:a@ex.com');
    expect(req).toContain('ATTENDEE:mailto:b@ex.com');
    expect(req).toContain('DTSTART:20260720T000000Z');
  });
});

describe('setAttendeePartstat', () => {
  const ics = buildEventICal({
    uid: 'p-1@ox-mcp',
    summary: 'RSVP me',
    start: '2026-07-22T10:00:00Z',
    end: '2026-07-22T11:00:00Z',
    attendees: [{ email: 'me@ex.com' }, { email: 'other@ex.com' }],
  }).ical;

  it('sets PARTSTAT only on the matching attendee (case-insensitive)', () => {
    const updated = setAttendeePartstat(ics, 'ME@EX.COM', 'DECLINED');
    expect(updated).toMatch(/ATTENDEE;[^\n]*PARTSTAT=DECLINED[^\n]*me@ex\.com/i);
    expect(updated).not.toMatch(/other@ex\.com[^\n]*DECLINED/i);
    // still a full VCALENDAR
    expect(updated).toContain('BEGIN:VCALENDAR');
    expect(updated).toContain('END:VCALENDAR');
  });

  it('replaces an existing PARTSTAT', () => {
    const once = setAttendeePartstat(ics, 'me@ex.com', 'TENTATIVE');
    const twice = setAttendeePartstat(once, 'me@ex.com', 'ACCEPTED');
    expect(twice).toMatch(/PARTSTAT=ACCEPTED/);
    expect(twice).not.toMatch(/PARTSTAT=TENTATIVE/);
  });

  it('throws when the email is not an attendee', () => {
    expect(() => setAttendeePartstat(ics, 'ghost@ex.com', 'ACCEPTED')).toThrow(/not an attendee/);
  });
});

describe('parseEvents — recurrence expansion', () => {
  const DAILY_ICS = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//EN',
    'BEGIN:VEVENT',
    'UID:daily-1',
    'DTSTAMP:20260601T000000Z',
    'DTSTART:20260625T090000Z',
    'DTEND:20260625T093000Z',
    'RRULE:FREQ=DAILY',
    'EXDATE:20260721T090000Z',
    'SUMMARY:Daily standup',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:daily-1',
    'RECURRENCE-ID:20260722T090000Z',
    'DTSTAMP:20260601T000000Z',
    'DTSTART:20260722T100000Z',
    'DTEND:20260722T103000Z',
    'SUMMARY:Daily standup (moved)',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  it('expands a daily series into instances within the range', () => {
    const events = parseEvents(DAILY_ICS, {
      start: '2026-07-20T00:00:00Z',
      end: '2026-07-21T00:00:00Z',
    });
    expect(events).toHaveLength(1);
    expect(events[0].start).toBe('2026-07-20T09:00:00.000Z');
    expect(events[0].summary).toBe('Daily standup');
  });

  it('honors EXDATE (cancelled instance)', () => {
    const events = parseEvents(DAILY_ICS, {
      start: '2026-07-21T00:00:00Z',
      end: '2026-07-22T00:00:00Z',
    });
    expect(events).toHaveLength(0);
  });

  it('honors RECURRENCE-ID overrides (moved instance)', () => {
    const events = parseEvents(DAILY_ICS, {
      start: '2026-07-22T00:00:00Z',
      end: '2026-07-23T00:00:00Z',
    });
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Daily standup (moved)');
    expect(events[0].start).toBe('2026-07-22T10:00:00.000Z');
  });

  it('returns multiple instances for a multi-day range, sorted', () => {
    const events = parseEvents(DAILY_ICS, {
      start: '2026-07-01T00:00:00Z',
      end: '2026-07-04T00:00:00Z',
    });
    expect(events.map((e) => e.start)).toEqual([
      '2026-07-01T09:00:00.000Z',
      '2026-07-02T09:00:00.000Z',
      '2026-07-03T09:00:00.000Z',
    ]);
  });

  it('drops a non-recurring master outside the range', () => {
    const single = buildEventICal({
      uid: 's1@ox-mcp',
      summary: 'Old meeting',
      start: '2025-01-01T10:00:00Z',
      end: '2025-01-01T11:00:00Z',
    }).ical;
    expect(
      parseEvents(single, { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' }),
    ).toEqual([]);
  });

  it('keeps the master as-is when no range is given (old behavior)', () => {
    const events = parseEvents(DAILY_ICS);
    expect(events.map((e) => e.summary)).toEqual(['Daily standup', 'Daily standup (moved)']);
  });
});
