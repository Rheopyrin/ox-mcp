import { beforeEach, describe, expect, it } from 'vitest';
import { makeFakes, makeRegistry, type Fakes } from './harness.js';
import type { ToolRegistry } from '../../src/tools/registry.js';

let fakes: Fakes;
let reg: ToolRegistry;

beforeEach(() => {
  fakes = makeFakes();
  reg = makeRegistry(fakes);
});

const range = { start: '2026-07-20T00:00:00Z', end: '2026-07-21T00:00:00Z' };

describe('calendar tool dispatch', () => {
  const cases: [string, Record<string, unknown>, (f: Fakes) => unknown][] = [
    ['calendar_list', {}, (f) => f.caldav.listCalendars],
    ['calendar_list_events', { calendar: 'u', ...range }, (f) => f.caldav.listEvents],
    ['calendar_free_busy', { attendees: ['a@example.com'], ...range }, (f) => f.freeBusy.getFreeBusy],
    [
      'calendar_create_event',
      { calendar: 'u', summary: 'M', start: '2026-07-20T09:00:00Z', end: '2026-07-20T10:00:00Z' },
      (f) => f.caldav.createEvent,
    ],
    [
      'calendar_update_event',
      { objectUrl: 'u/e1.ics', summary: 'M', start: '2026-07-20T09:00:00Z', end: '2026-07-20T10:00:00Z' },
      (f) => f.caldav.updateEvent,
    ],
    ['calendar_delete_event', { objectUrl: 'u/e1.ics' }, (f) => f.caldav.deleteEvent],
    ['calendar_accept_event', { calendar: 'u', objectUrl: 'u/e1.ics' }, (f) => f.caldav.respondToEvent],
    ['calendar_decline_event', { calendar: 'u', objectUrl: 'u/e1.ics' }, (f) => f.caldav.respondToEvent],
    ['calendar_tentative_event', { calendar: 'u', objectUrl: 'u/e1.ics' }, (f) => f.caldav.respondToEvent],
  ];

  it.each(cases)('%s dispatches to the right client method', async (name, args, getSpy) => {
    const res = await reg.dispatch(name, args);
    expect(res.isError, res.content[0]?.text).toBeFalsy();
    expect(getSpy(fakes)).toHaveBeenCalled();
  });

  it('RSVP tools pass the right PARTSTAT', async () => {
    await reg.dispatch('calendar_accept_event', { calendar: 'u', objectUrl: 'o' });
    await reg.dispatch('calendar_decline_event', { calendar: 'u', objectUrl: 'o' });
    await reg.dispatch('calendar_tentative_event', { calendar: 'u', objectUrl: 'o' });
    expect(fakes.caldav.respondToEvent).toHaveBeenNthCalledWith(1, 'u', 'o', 'ACCEPTED');
    expect(fakes.caldav.respondToEvent).toHaveBeenNthCalledWith(2, 'u', 'o', 'DECLINED');
    expect(fakes.caldav.respondToEvent).toHaveBeenNthCalledWith(3, 'u', 'o', 'TENTATIVE');
  });

  it('all three RSVP tools are gated by the single respondEvent feature', async () => {
    const gated = makeRegistry(fakes, {
      servers: { default: { calDav: { server: 'dav.example.com', auth: { type: 'basic', user: 'me@example.com', appPassword: 'pw' } } } }, // calDav reads on, writes off by default
    });
    for (const name of ['calendar_accept_event', 'calendar_decline_event', 'calendar_tentative_event']) {
      const res = await gated.dispatch(name, { calendar: 'u', objectUrl: 'o' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/disabled/);
    }
  });
});
