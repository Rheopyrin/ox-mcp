import { describe, expect, it, vi } from 'vitest';
import { CalDavClient, type TsdavBackend } from '../../src/calendar/caldav-client.js';
import { buildEventICal } from '../../src/calendar/ical.js';
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

const CAL_URL = 'https://dav.example.com/cal/1/';

function makeBackend(overrides: Partial<TsdavBackend> = {}) {
  const eventIcal = buildEventICal({
    uid: 'ev-1@ox-mcp',
    summary: 'Meeting',
    start: '2026-07-20T10:00:00Z',
    end: '2026-07-20T11:00:00Z',
  }).ical;

  const backend: TsdavBackend = {
    fetchCalendars: vi.fn(async () => [
      { url: CAL_URL, displayName: 'Personal', ctag: 'c1' },
    ]),
    fetchCalendarObjects: vi.fn(async () => [
      { url: `${CAL_URL}ev-1.ics`, etag: 'e1', data: eventIcal },
    ]),
    createCalendarObject: vi.fn(async () => ({ ok: true, status: 201 })),
    updateCalendarObject: vi.fn(async () => ({ ok: true, status: 204 })),
    deleteCalendarObject: vi.fn(async () => ({ ok: true, status: 204 })),
    ...overrides,
  };
  return backend;
}

function makeClient(backend: TsdavBackend) {
  const captured: { header?: string } = {};
  const client = new CalDavClient(section, auth, async (_acct, header) => {
    captured.header = header;
    return backend;
  });
  return { client, captured };
}

describe('CalDavClient', () => {
  it('lists calendars with the resolved DAV auth header', async () => {
    const backend = makeBackend();
    const { client, captured } = makeClient(backend);
    const cals = await client.listCalendars();
    expect(captured.header).toBe('Basic abc');
    expect(cals).toEqual([{ url: CAL_URL, displayName: 'Personal', ctag: 'c1' }]);
  });

  it('lists events within a time range and attaches object refs', async () => {
    const backend = makeBackend();
    const { client } = makeClient(backend);
    const events = await client.listEvents(CAL_URL, '2026-07-20T00:00:00Z', '2026-07-21T00:00:00Z');
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe('Meeting');
    expect(events[0]).toMatchObject({ objectUrl: `${CAL_URL}ev-1.ics`, etag: 'e1' });
    expect(backend.fetchCalendarObjects).toHaveBeenCalledWith(
      expect.objectContaining({ timeRange: { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' } }),
    );
  });

  it('resolves a calendar by display name too', async () => {
    const backend = makeBackend();
    const { client } = makeClient(backend);
    const events = await client.listEvents('Personal', '2026-07-20T00:00:00Z', '2026-07-21T00:00:00Z');
    expect(events).toHaveLength(1);
  });

  it('creates an event and returns uid + url', async () => {
    const backend = makeBackend();
    const { client } = makeClient(backend);
    const res = await client.createEvent(CAL_URL, {
      summary: 'New',
      start: '2026-07-22T09:00:00Z',
      end: '2026-07-22T10:00:00Z',
    });
    expect(res.uid).toBeTruthy();
    expect(res.url).toContain(CAL_URL);
    const call = (backend.createCalendarObject as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.iCalString).toContain('SUMMARY:New');
    expect(call.filename).toBe(`${res.uid}.ics`);
  });

  it('updates and deletes events', async () => {
    const backend = makeBackend();
    const { client } = makeClient(backend);
    await client.updateEvent(`${CAL_URL}ev-1.ics`, {
      uid: 'ev-1@ox-mcp',
      summary: 'Updated',
      start: '2026-07-20T10:00:00Z',
      end: '2026-07-20T11:30:00Z',
    }, 'e1');
    await client.deleteEvent(`${CAL_URL}ev-1.ics`, 'e1');
    expect(backend.updateCalendarObject).toHaveBeenCalled();
    expect(backend.deleteCalendarObject).toHaveBeenCalledWith({
      calendarObject: { url: `${CAL_URL}ev-1.ics`, etag: 'e1' },
    });
  });

  it('throws a helpful error for an unknown calendar', async () => {
    const backend = makeBackend();
    const { client } = makeClient(backend);
    await expect(
      client.listEvents('nope', '2026-07-20T00:00:00Z', '2026-07-21T00:00:00Z'),
    ).rejects.toThrow(/not found/);
  });

  it('throws when a write is rejected by the server', async () => {
    const backend = makeBackend({
      createCalendarObject: vi.fn(async () => ({ ok: false, status: 403 })),
    });
    const { client } = makeClient(backend);
    await expect(
      client.createEvent(CAL_URL, { summary: 'x', start: '2026-07-22T09:00:00Z', end: '2026-07-22T10:00:00Z' }),
    ).rejects.toThrow(/failed \(403\)/);
  });
});

describe('CalDavClient — respondToEvent', () => {
  const inviteIcal = buildEventICal({
    uid: 'inv-1@ox-mcp',
    summary: 'Invite',
    start: '2026-07-22T10:00:00Z',
    end: '2026-07-22T11:00:00Z',
    organizer: { email: 'boss@ex.com' },
    attendees: [{ email: 'me@ex.com' }, { email: 'other@ex.com' }],
  }).ical;

  function inviteBackend() {
    return makeBackend({
      fetchCalendarObjects: vi.fn(async () => [
        { url: `${CAL_URL}inv-1.ics`, etag: 'e9', data: inviteIcal },
      ]),
    });
  }

  it('rewrites own PARTSTAT and PUTs the event back with the etag', async () => {
    const backend = inviteBackend();
    const { client } = makeClient(backend);
    await client.respondToEvent(CAL_URL, `${CAL_URL}inv-1.ics`, 'ACCEPTED');

    expect(backend.fetchCalendarObjects).toHaveBeenCalledWith(
      expect.objectContaining({ objectUrls: [`${CAL_URL}inv-1.ics`] }),
    );
    const putArg = (backend.updateCalendarObject as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(putArg.calendarObject.etag).toBe('e9');
    expect(putArg.calendarObject.data).toMatch(/ATTENDEE;[^\n]*PARTSTAT=ACCEPTED[^\n]*me@ex\.com/i);
    expect(putArg.calendarObject.data).not.toMatch(/other@ex\.com[^\n]*ACCEPTED/i);
  });

  it('errors when the account is not an attendee', async () => {
    const stranger = buildEventICal({
      uid: 'inv-2@ox-mcp',
      summary: 'Not mine',
      start: '2026-07-22T10:00:00Z',
      end: '2026-07-22T11:00:00Z',
      attendees: [{ email: 'other@ex.com' }],
    }).ical;
    const backend = makeBackend({
      fetchCalendarObjects: vi.fn(async () => [{ url: `${CAL_URL}inv-2.ics`, etag: 'e1', data: stranger }]),
    });
    const { client } = makeClient(backend);
    await expect(client.respondToEvent(CAL_URL, `${CAL_URL}inv-2.ics`, 'DECLINED')).rejects.toThrow(
      /not an attendee/,
    );
  });

  it('errors when the object is missing', async () => {
    const backend = makeBackend({ fetchCalendarObjects: vi.fn(async () => []) });
    const { client } = makeClient(backend);
    await expect(client.respondToEvent(CAL_URL, `${CAL_URL}gone.ics`, 'TENTATIVE')).rejects.toThrow(
      /Event object not found/,
    );
  });
});

describe('CalDavClient — object URLs never leave the CalDAV server', () => {
  const input = { summary: 'x', start: '2026-07-20T10:00:00Z', end: '2026-07-20T11:00:00Z' };

  // Model-controlled objectUrl values that must not receive the Authorization header.
  const hostile = [
    'https://evil.example/steal.ics',
    'https://dav.example.com@evil.example/steal.ics', // userinfo trick
    'https://dav.example.com.evil.example/steal.ics', // suffix lookalike
    '//evil.example/steal.ics', // protocol-relative
    'http://dav.example.com/cal/1/ev-1.ics', // cleartext downgrade
    'https://dav.example.com:8443/cal/1/ev-1.ics', // different port = different origin
    'javascript:alert(1)',
  ];

  it.each(hostile)('updateEvent refuses %s without sending a request', async (url) => {
    const backend = makeBackend();
    const { client } = makeClient(backend);
    await expect(client.updateEvent(url, input, 'e1')).rejects.toThrow(/Refusing to send CalDAV credentials/);
    expect(backend.updateCalendarObject).not.toHaveBeenCalled();
  });

  it.each(hostile)('deleteEvent refuses %s without sending a request', async (url) => {
    const backend = makeBackend();
    const { client } = makeClient(backend);
    await expect(client.deleteEvent(url, 'e1')).rejects.toThrow(/Refusing to send CalDAV credentials/);
    expect(backend.deleteCalendarObject).not.toHaveBeenCalled();
  });

  it.each(hostile)('respondToEvent refuses %s before fetching it', async (url) => {
    const backend = makeBackend();
    const { client } = makeClient(backend);
    await expect(client.respondToEvent(CAL_URL, url, 'ACCEPTED')).rejects.toThrow(
      /Refusing to send CalDAV credentials/,
    );
    expect(backend.fetchCalendarObjects).not.toHaveBeenCalled();
    expect(backend.updateCalendarObject).not.toHaveBeenCalled();
  });

  it('respondToEvent refuses to PUT back to a foreign URL returned by the server', async () => {
    const invite = buildEventICal({
      uid: 'inv-3@ox-mcp',
      summary: 'Invite',
      start: '2026-07-22T10:00:00Z',
      end: '2026-07-22T11:00:00Z',
      attendees: [{ email: 'me@ex.com' }],
    }).ical;
    const backend = makeBackend({
      fetchCalendarObjects: vi.fn(async () => [{ url: 'https://evil.example/inv-3.ics', etag: 'e1', data: invite }]),
    });
    const { client } = makeClient(backend);
    await expect(client.respondToEvent(CAL_URL, `${CAL_URL}inv-3.ics`, 'ACCEPTED')).rejects.toThrow(
      /Refusing to send CalDAV credentials/,
    );
    expect(backend.updateCalendarObject).not.toHaveBeenCalled();
  });

  it('resolves relative paths against the configured server', async () => {
    const backend = makeBackend();
    const { client } = makeClient(backend);
    await client.deleteEvent('/cal/1/ev-1.ics', 'e1');
    expect(backend.deleteCalendarObject).toHaveBeenCalledWith({
      calendarObject: { url: `${CAL_URL}ev-1.ics`, etag: 'e1' },
    });
  });

  it('strips userinfo from same-origin URLs', async () => {
    const backend = makeBackend();
    const { client } = makeClient(backend);
    await client.deleteEvent('https://x:y@dav.example.com/cal/1/ev-1.ics', 'e1');
    expect(backend.deleteCalendarObject).toHaveBeenCalledWith({
      calendarObject: { url: `${CAL_URL}ev-1.ics`, etag: 'e1' },
    });
  });

  it('allows hosts the server itself lists calendars on (split-host providers)', async () => {
    const shard = 'https://p42-caldav.example.net/123/calendars/home/';
    const backend = makeBackend({
      fetchCalendars: vi.fn(async () => [{ url: shard, displayName: 'Home' }]),
    });
    const { client } = makeClient(backend);
    await client.updateEvent(`${shard}ev-9.ics`, input, 'e1');
    const putArg = (backend.updateCalendarObject as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(putArg.calendarObject.url).toBe(`${shard}ev-9.ics`);
  });

  it('rejects a create whose uid would resolve to another host', async () => {
    const backend = makeBackend();
    const { client } = makeClient(backend);
    for (const uid of ['https://evil.example/steal', '//evil.example/steal', 'http://dav.example.com/cal/1/x']) {
      await expect(client.createEvent(CAL_URL, { ...input, uid })).rejects.toThrow(
        /Refusing to send CalDAV credentials/,
      );
    }
    expect(backend.createCalendarObject).not.toHaveBeenCalled();
  });
});
