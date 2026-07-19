import { z } from 'zod';
import { json, serverParam, type Tool } from './tool.js';

const contactList: Tool = {
  name: 'contact_list',
  title: 'List contacts',
  description:
    'List all CardDAV contacts. Reads all address books unless one is given. To search, use contact_find instead.',
  readOnly: true,
  inputSchema: {
    addressBook: z.string().optional().describe('Address book URL or display name; omit for all.'),
    ...serverParam,
  },
  async execute(args, ctx) {
    const account = ctx.resolver.getServer(args.server as string | undefined);
    const contacts = await ctx.carddav
      .forAccount(account)
      .listContacts(args.addressBook as string | undefined);
    return json(contacts);
  },
};

const contactFind: Tool = {
  name: 'contact_find',
  title: 'Find contacts',
  description:
    'Search CardDAV contacts by a case-insensitive substring (server-side where supported). Useful for resolving a name to an email address, e.g. before calendar_free_busy.',
  readOnly: true,
  inputSchema: {
    query: z.string().min(1).describe('Text to match.'),
    fields: z
      .array(z.enum(['name', 'email', 'phone', 'org']))
      .optional()
      .describe('Fields to search (default: name + email).'),
    addressBook: z.string().optional().describe('Address book URL or display name; omit for all.'),
    limit: z.number().int().min(1).max(200).default(50),
    ...serverParam,
  },
  async execute(args, ctx) {
    const account = ctx.resolver.getServer(args.server as string | undefined);
    const contacts = await ctx.carddav
      .forAccount(account)
      .findContacts(
        args.query as string,
        args.fields as ('name' | 'email' | 'phone' | 'org')[] | undefined,
        args.addressBook as string | undefined,
        (args.limit as number) ?? 50,
      );
    return json(contacts);
  },
};

const contactCreate: Tool = {
  name: 'contact_create',
  title: 'Create contact',
  description: 'Create a CardDAV contact (vCard) in an address book.',
  readOnly: false,
  inputSchema: {
    name: z.string().describe('Full display name.'),
    emails: z.array(z.string()).optional(),
    phones: z.array(z.string()).optional(),
    organization: z.string().optional(),
    addressBook: z.string().optional().describe('Address book URL or display name; defaults to the first one.'),
    ...serverParam,
  },
  async execute(args, ctx) {
    const account = ctx.resolver.getServer(args.server as string | undefined);
    const res = await ctx.carddav.forAccount(account).createContact(
      {
        name: args.name as string,
        emails: args.emails as string[] | undefined,
        phones: args.phones as string[] | undefined,
        organization: args.organization as string | undefined,
      },
      args.addressBook as string | undefined,
    );
    return json(res);
  },
};

export const contactTools: Tool[] = [contactList, contactFind, contactCreate];
