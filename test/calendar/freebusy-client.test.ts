import { describe, expect, it, vi } from 'vitest';
import { FreeBusyClient, parseScheduleResponse, type FetchFn } from '../../src/calendar/freebusy-client.js';
import type { ResolvedSection } from '../../src/config/config-resolver.js';
import type { AuthProvider } from '../../src/auth/auth-provider.js';

const section: ResolvedSection = {
  server: 'dav.example.com',
  auth: { type: 'basic', user: 'me@ex.com', appPassword: 'pw' },
};

const auth: AuthProvider = {
  getImapAuth: async () => ({ user: 'me@ex.com', pass: 'pw' }),
  getSmtpAuth: async () => ({ user: 'me@ex.com', pass: 'pw' }),
  getDavAuthHeader: async () => 'Basic abc',
};

function textResponse(body: string, ok = true, status = 200): Response {
  return { ok, status, text: async () => body } as unknown as Response;
}

const PRINCIPAL_XML = `<multistatus xmlns="DAV:"><response><propstat><prop>
  <current-user-principal><href>/principals/users/me/</href></current-user-principal>
</prop></propstat></response></multistatus>`;

const OUTBOX_XML = `<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><response><propstat><prop>
  <c:schedule-outbox-URL><href>/calendars/me/outbox/</href></c:schedule-outbox-URL>
</prop></propstat></response></multistatus>`;

const FB_ICAL =
  'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:x\r\nBEGIN:VFREEBUSY\r\n' +
  'DTSTART:20260720T000000Z\r\nDTEND:20260721T000000Z\r\n' +
  'FREEBUSY;FBTYPE=BUSY:20260720T090000Z/20260720T093000Z\r\n' +
  'END:VFREEBUSY\r\nEND:VCALENDAR\r\n';

function scheduleResponseXml(calData: string): string {
  return `<schedule-response xmlns="urn:ietf:params:xml:ns:caldav" xmlns:d="DAV:">
    <response>
      <recipient><d:href>mailto:colleague@ex.com</d:href></recipient>
      <request-status>2.0;Success</request-status>
      <calendar-data>${calData}</calendar-data>
    </response>
  </schedule-response>`;
}

describe('FreeBusyClient', () => {
  it('discovers the outbox, posts a VFREEBUSY, and parses busy periods', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method;
      const body = String(init?.body ?? '');
      if (method === 'PROPFIND' && body.includes('current-user-principal')) return textResponse(PRINCIPAL_XML);
      if (method === 'PROPFIND' && body.includes('schedule-outbox-URL')) return textResponse(OUTBOX_XML);
      if (method === 'POST') return textResponse(scheduleResponseXml(FB_ICAL));
      throw new Error(`unexpected ${method} ${url}`);
    });

    const client = new FreeBusyClient(section, auth, fetchFn as unknown as FetchFn);
    const result = await client.getFreeBusy(
      ['colleague@ex.com'],
      '2026-07-20T00:00:00Z',
      '2026-07-21T00:00:00Z',
    );

    expect(result).toHaveLength(1);
    expect(result[0].attendee).toBe('colleague@ex.com');
    expect(result[0].status).toBe('2.0;Success');
    expect(result[0].busy).toHaveLength(1);
    expect(new Date(result[0].busy[0].start).toISOString()).toBe('2026-07-20T09:00:00.000Z');

    // POST hit the resolved absolute outbox URL with a REQUEST body
    const postCall = fetchFn.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'POST')!;
    expect(postCall[0]).toBe('https://dav.example.com/calendars/me/outbox/');
    expect(String((postCall[1] as RequestInit).body)).toContain('ATTENDEE:mailto:colleague@ex.com');
  });

  it('throws when the server advertises no scheduling outbox', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      if (body.includes('current-user-principal')) return textResponse(PRINCIPAL_XML);
      return textResponse('<multistatus xmlns="DAV:"><response/></multistatus>'); // no outbox href
    });
    const client = new FreeBusyClient(section, auth, fetchFn as unknown as FetchFn);
    await expect(
      client.getFreeBusy(['x@ex.com'], '2026-07-20T00:00:00Z', '2026-07-21T00:00:00Z'),
    ).rejects.toThrow(/does not advertise/);
  });

  it('returns empty for no attendees without hitting the network', async () => {
    const fetchFn = vi.fn();
    const client = new FreeBusyClient(section, auth, fetchFn as unknown as FetchFn);
    expect(await client.getFreeBusy([], '2026-07-20T00:00:00Z', '2026-07-21T00:00:00Z')).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('parseScheduleResponse', () => {
  it('handles multiple attendees', () => {
    const xml = `<schedule-response xmlns="urn:ietf:params:xml:ns:caldav" xmlns:d="DAV:">
      <response><recipient><d:href>mailto:a@ex.com</d:href></recipient><request-status>2.0;OK</request-status><calendar-data>${FB_ICAL}</calendar-data></response>
      <response><recipient><d:href>mailto:b@ex.com</d:href></recipient><request-status>3.7;No such user</request-status></response>
    </schedule-response>`;
    const parsed = parseScheduleResponse(xml);
    expect(parsed.map((p) => p.attendee)).toEqual(['a@ex.com', 'b@ex.com']);
    expect(parsed[0].busy).toHaveLength(1);
    expect(parsed[1].busy).toHaveLength(0);
  });
});

describe('parseScheduleResponse — Open-Xchange CDATA format (real-world sample)', () => {
  // Captured verbatim from an OX 7.10.6 schedule-outbox response: calendar-data
  // is CDATA-wrapped with LF line endings. Regression test for a crash where
  // the CDATA wrapper reached ICAL.parse ("propertyGroups" TypeError).
  const OX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CAL:schedule-response xmlns:CAL="urn:ietf:params:xml:ns:caldav">
  <CAL:response>
    <CAL:recipient>
      <D:href xmlns:D="DAV:">mailto:alex@example.com</D:href>
    </CAL:recipient>
    <CAL:request-status>2.0;Success</CAL:request-status>
    <CAL:calendar-data><![CDATA[BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Open-Xchange//7.10.6-Rev92//EN
METHOD:REPLY
BEGIN:VFREEBUSY
DTSTAMP:20260719T122815Z
ATTENDEE:mailto:alex@example.com
DTEND:20260720T210000Z
DTSTART:20260719T210000Z
FREEBUSY;FBTYPE=BUSY:20260720T080000Z/20260720T083000Z
FREEBUSY;FBTYPE=BUSY:20260720T120000Z/20260720T140000Z
ORGANIZER:mailto:me@example.com
UID:test-1@ox-mcp
END:VFREEBUSY
END:VCALENDAR]]></CAL:calendar-data>
    <D:responsedescription xmlns:D="DAV:">OK</D:responsedescription>
  </CAL:response>
</CAL:schedule-response>`;

  it('unwraps CDATA calendar-data and parses busy periods', () => {
    const parsed = parseScheduleResponse(OX_XML);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].attendee).toBe('alex@example.com');
    expect(parsed[0].status).toBe('2.0;Success');
    expect(parsed[0].busy).toHaveLength(2);
    expect(parsed[0].busy[0]).toEqual({
      start: '2026-07-20T08:00:00.000Z',
      end: '2026-07-20T08:30:00.000Z',
      type: 'BUSY',
    });
    expect(parsed[0].busy[1].end).toBe('2026-07-20T14:00:00.000Z');
  });
});
