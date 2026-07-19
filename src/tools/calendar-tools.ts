import { z } from 'zod';
import { json, serverParam, text, type Tool } from './tool.js';
import type { EventInput, Partstat } from '../calendar/ical.js';

const attendeeSchema = z.array(z.object({ email: z.string(), name: z.string().optional() }));

function buildEventInput(args: Record<string, unknown>): EventInput {
  return {
    uid: args.uid as string | undefined,
    summary: args.summary as string,
    start: args.start as string,
    end: args.end as string,
    description: args.description as string | undefined,
    location: args.location as string | undefined,
    allDay: args.allDay as boolean | undefined,
    attendees: args.attendees as { email: string; name?: string }[] | undefined,
  };
}

const calendarList: Tool = {
  name: 'calendar_list',
  title: 'List calendars',
  description: 'List CalDAV calendars (own and any shared with the account).',
  readOnly: true,
  inputSchema: { ...serverParam },
  async execute(args, ctx) {
    const account = ctx.resolver.getServer(args.server as string | undefined);
    return json(await ctx.caldav.forAccount(account).listCalendars());
  },
};

const calendarListEvents: Tool = {
  name: 'calendar_list_events',
  title: 'List calendar events',
  description: 'List events in a calendar within a time range.',
  readOnly: true,
  inputSchema: {
    calendar: z.string().describe('Calendar URL or display name (see calendar_list).'),
    start: z.string().describe('ISO 8601 range start.'),
    end: z.string().describe('ISO 8601 range end.'),
    ...serverParam,
  },
  async execute(args, ctx) {
    const account = ctx.resolver.getServer(args.server as string | undefined);
    const events = await ctx.caldav
      .forAccount(account)
      .listEvents(args.calendar as string, args.start as string, args.end as string);
    return json(events);
  },
};

const calendarFreeBusy: Tool = {
  name: 'calendar_free_busy',
  title: 'Get free/busy',
  description:
    "Query attendees' availability (busy/free windows only) via the CalDAV scheduling outbox. No calendar sharing required.",
  readOnly: true,
  inputSchema: {
    attendees: z.array(z.string()).min(1).describe('Email addresses to check.'),
    start: z.string().describe('ISO 8601 range start.'),
    end: z.string().describe('ISO 8601 range end.'),
    ...serverParam,
  },
  async execute(args, ctx) {
    const account = ctx.resolver.getServer(args.server as string | undefined);
    const fb = await ctx.freeBusy
      .forAccount(account)
      .getFreeBusy(args.attendees as string[], args.start as string, args.end as string);
    return json(fb);
  },
};

const calendarCreateEvent: Tool = {
  name: 'calendar_create_event',
  title: 'Create calendar event',
  description: 'Create a calendar event (VEVENT) in a calendar.',
  readOnly: false,
  inputSchema: {
    calendar: z.string().describe('Calendar URL or display name.'),
    summary: z.string(),
    start: z.string().describe('ISO 8601 start.'),
    end: z.string().describe('ISO 8601 end.'),
    description: z.string().optional(),
    location: z.string().optional(),
    allDay: z.boolean().optional(),
    attendees: attendeeSchema.optional(),
    ...serverParam,
  },
  async execute(args, ctx) {
    const account = ctx.resolver.getServer(args.server as string | undefined);
    const res = await ctx.caldav.forAccount(account).createEvent(args.calendar as string, buildEventInput(args));
    return json(res);
  },
};

const calendarUpdateEvent: Tool = {
  name: 'calendar_update_event',
  title: 'Update calendar event',
  description: 'Replace an existing calendar event by its object URL.',
  readOnly: false,
  inputSchema: {
    objectUrl: z.string().describe('Calendar object URL (from calendar_list_events).'),
    uid: z.string().optional(),
    summary: z.string(),
    start: z.string(),
    end: z.string(),
    description: z.string().optional(),
    location: z.string().optional(),
    allDay: z.boolean().optional(),
    attendees: attendeeSchema.optional(),
    etag: z.string().optional(),
    ...serverParam,
  },
  async execute(args, ctx) {
    const account = ctx.resolver.getServer(args.server as string | undefined);
    await ctx.caldav
      .forAccount(account)
      .updateEvent(args.objectUrl as string, buildEventInput(args), args.etag as string | undefined);
    return text('Event updated.');
  },
};

const calendarDeleteEvent: Tool = {
  name: 'calendar_delete_event',
  title: 'Delete calendar event',
  description: 'Delete a calendar event by its object URL.',
  readOnly: false,
  destructive: true,
  inputSchema: {
    objectUrl: z.string(),
    etag: z.string().optional(),
    ...serverParam,
  },
  async execute(args, ctx) {
    const account = ctx.resolver.getServer(args.server as string | undefined);
    await ctx.caldav.forAccount(account).deleteEvent(args.objectUrl as string, args.etag as string | undefined);
    return text('Event deleted.');
  },
};

function respondTool(name: string, partstat: Partstat, verb: string): Tool {
  return {
    name,
    title: `${verb} event invitation`,
    description: `${verb} a calendar event invitation as this account (sets your PARTSTAT to ${partstat}; the server notifies the organizer).`,
    readOnly: false,
    inputSchema: {
      calendar: z.string().describe('Calendar URL or display name containing the event.'),
      objectUrl: z.string().describe('Calendar object URL (from calendar_list_events).'),
      ...serverParam,
    },
    async execute(args, ctx) {
      const account = ctx.resolver.getServer(args.server as string | undefined);
      await ctx.caldav
        .forAccount(account)
        .respondToEvent(args.calendar as string, args.objectUrl as string, partstat);
      return text(`Responded ${partstat} to the invitation.`);
    },
  };
}

const calendarAcceptEvent = respondTool('calendar_accept_event', 'ACCEPTED', 'Accept');
const calendarDeclineEvent = respondTool('calendar_decline_event', 'DECLINED', 'Decline');
const calendarTentativeEvent = respondTool('calendar_tentative_event', 'TENTATIVE', 'Tentatively accept');

export const calendarTools: Tool[] = [
  calendarList,
  calendarListEvents,
  calendarFreeBusy,
  calendarCreateEvent,
  calendarUpdateEvent,
  calendarDeleteEvent,
  calendarAcceptEvent,
  calendarDeclineEvent,
  calendarTentativeEvent,
];
