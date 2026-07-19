import { z } from 'zod';
import { errorResult, json, serverParam, text, type Tool } from './tool.js';
import type { SearchCriteria } from '../mail/imap-client.js';
import type { OutgoingMessage } from '../mail/smtp-client.js';

const recipients = z.union([z.string(), z.array(z.string())]);

function buildOutgoing(args: Record<string, unknown>): OutgoingMessage {
  return {
    to: args.to as string | string[],
    cc: args.cc as string | string[] | undefined,
    bcc: args.bcc as string | string[] | undefined,
    subject: (args.subject as string) ?? '',
    text: args.text as string | undefined,
    html: args.html as string | undefined,
    inReplyTo: args.inReplyTo as string | undefined,
    references: args.references as string | undefined,
  };
}

// --- Reads ---

const emailListFolders: Tool = {
  name: 'email_list_folders',
  title: 'List mail folders',
  description: 'List IMAP mailboxes/folders for an account.',
  readOnly: true,
  inputSchema: { ...serverParam },
  async execute(args, ctx) {
    const account = ctx.resolver.getServer(args.server as string | undefined);
    return json(await ctx.imap.forAccount(account).listFolders());
  },
};

const emailList: Tool = {
  name: 'email_list',
  title: 'List emails',
  description: 'List the most recent emails in a folder (newest first).',
  readOnly: true,
  inputSchema: {
    folder: z.string().default('INBOX').describe('Mailbox to list (default INBOX).'),
    limit: z.number().int().min(1).max(200).default(25),
    ...serverParam,
  },
  async execute(args, ctx) {
    const account = ctx.resolver.getServer(args.server as string | undefined);
    const messages = await ctx.imap
      .forAccount(account)
      .listMessages((args.folder as string) ?? 'INBOX', (args.limit as number) ?? 25);
    return json(messages);
  },
};

const emailRead: Tool = {
  name: 'email_read',
  title: 'Read email',
  description: 'Read a single email (headers + body) by UID.',
  readOnly: true,
  inputSchema: {
    folder: z.string().default('INBOX'),
    uid: z.number().int().describe('IMAP UID of the message.'),
    ...serverParam,
  },
  async execute(args, ctx) {
    const account = ctx.resolver.getServer(args.server as string | undefined);
    const msg = await ctx.imap
      .forAccount(account)
      .readMessage((args.folder as string) ?? 'INBOX', args.uid as number);
    return msg ? json(msg) : text(`No message with UID ${args.uid} in ${args.folder ?? 'INBOX'}.`);
  },
};

const emailSearch: Tool = {
  name: 'email_search',
  title: 'Search emails',
  description:
    'Search emails by from/to/subject/body/text, date range, and flags. Searches ALL folders unless a folder is given. ' +
    'Note: on the ox-api transport, `body`/`text` match only the subject and addresses of recent messages (not full message bodies); use the imap transport for true full-text search.',
  readOnly: true,
  inputSchema: {
    folder: z.string().optional().describe('Folder to search; omit to search every folder.'),
    from: z.string().optional(),
    to: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
    text: z.string().optional().describe('Match anywhere in headers or body.'),
    since: z.string().optional().describe('ISO date: only messages on/after this date.'),
    before: z.string().optional().describe('ISO date: only messages before this date.'),
    seen: z.boolean().optional(),
    flagged: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).default(50),
    ...serverParam,
  },
  async execute(args, ctx) {
    const account = ctx.resolver.getServer(args.server as string | undefined);
    const criteria: SearchCriteria = {
      from: args.from as string | undefined,
      to: args.to as string | undefined,
      subject: args.subject as string | undefined,
      body: args.body as string | undefined,
      text: args.text as string | undefined,
      since: args.since as string | undefined,
      before: args.before as string | undefined,
      seen: args.seen as boolean | undefined,
      flagged: args.flagged as boolean | undefined,
    };
    const results = await ctx.imap
      .forAccount(account)
      .search(args.folder as string | undefined, criteria, (args.limit as number) ?? 50);
    return json(results);
  },
};

// --- Writes ---

const emailSend: Tool = {
  name: 'email_send',
  title: 'Send email',
  description: 'Send an email via SMTP.',
  readOnly: false,
  inputSchema: {
    to: recipients,
    cc: recipients.optional(),
    bcc: recipients.optional(),
    subject: z.string(),
    text: z.string().optional(),
    html: z.string().optional(),
    inReplyTo: z.string().optional(),
    references: z.string().optional(),
    ...serverParam,
  },
  async execute(args, ctx) {
    const account = ctx.resolver.getServer(args.server as string | undefined);
    return json(await ctx.smtp.forAccount(account).send(buildOutgoing(args)));
  },
};

const emailSaveDraft: Tool = {
  name: 'email_save_draft',
  title: 'Save draft',
  description: 'Compose a message and save it to the Drafts folder (does not send).',
  readOnly: false,
  inputSchema: {
    to: recipients.optional(),
    cc: recipients.optional(),
    subject: z.string(),
    text: z.string().optional(),
    html: z.string().optional(),
    folder: z.string().default('Drafts'),
    ...serverParam,
  },
  async execute(args, ctx) {
    const account = ctx.resolver.getServer(args.server as string | undefined);
    const raw = await ctx.smtp.forAccount(account).buildRaw(buildOutgoing({ ...args, to: args.to ?? '' }));
    await ctx.imap.forAccount(account).saveDraft(raw, (args.folder as string) ?? 'Drafts');
    return text(`Draft saved to ${args.folder ?? 'Drafts'}.`);
  },
};

async function doReply(
  args: Record<string, unknown>,
  ctx: Parameters<Tool['execute']>[1],
  replyAll: boolean,
) {
  const account = ctx.resolver.getServer(args.server as string | undefined);
  const folder = (args.folder as string) ?? 'INBOX';
  const original = await ctx.imap.forAccount(account).readMessage(folder, args.uid as number);
  if (!original) {
    return errorResult(`No message with UID ${args.uid} in ${folder}.`);
  }
  if (original.fromAddresses.length === 0) {
    return errorResult('Original message has no sender address to reply to.');
  }

  const self = (account.mail?.auth.user ?? '').toLowerCase();
  const notSelf = (a: string) => a.toLowerCase() !== self;
  const to = replyAll
    ? dedupe([...original.fromAddresses, ...original.toAddresses.filter(notSelf)])
    : original.fromAddresses;
  const cc = replyAll ? dedupe(original.ccAddresses.filter(notSelf)) : [];
  const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;

  const result = await ctx.smtp.forAccount(account).send({
    to,
    cc: cc.length ? cc : undefined,
    subject,
    text: args.text as string | undefined,
    html: args.html as string | undefined,
    inReplyTo: original.messageId,
    references: original.messageId,
  });
  return json(result);
}

function replyTool(name: string, replyAll: boolean): Tool {
  return {
    name,
    title: replyAll ? 'Reply all' : 'Reply',
    description: replyAll
      ? 'Reply to all recipients of an email (sender + To/Cc, excluding yourself), threading preserved.'
      : 'Reply to the sender of an email, threading preserved.',
    readOnly: false,
    inputSchema: {
      folder: z.string().default('INBOX'),
      uid: z.number().int().describe('UID of the message to reply to.'),
      text: z.string().optional().describe('Plain-text reply body.'),
      html: z.string().optional().describe('HTML reply body.'),
      ...serverParam,
    },
    execute: (args, ctx) => doReply(args, ctx, replyAll),
  };
}

const emailReply = replyTool('email_reply', false);
const emailReplyAll = replyTool('email_reply_all', true);

function dedupe(values: string[]): string[] {
  return [...new Map(values.map((v) => [v.toLowerCase(), v])).values()];
}

const emailDelete: Tool = {
  name: 'email_delete',
  title: 'Delete email',
  description: 'Delete an email by UID (moves to Trash or expunges per server policy).',
  readOnly: false,
  destructive: true,
  inputSchema: {
    folder: z.string().default('INBOX'),
    uid: z.number().int(),
    ...serverParam,
  },
  async execute(args, ctx) {
    const account = ctx.resolver.getServer(args.server as string | undefined);
    await ctx.imap.forAccount(account).deleteMessage((args.folder as string) ?? 'INBOX', args.uid as number);
    return text(`Deleted UID ${args.uid} from ${args.folder ?? 'INBOX'}.`);
  },
};

const emailMove: Tool = {
  name: 'email_move',
  title: 'Move email',
  description: 'Move an email by UID to another folder.',
  readOnly: false,
  inputSchema: {
    folder: z.string().default('INBOX'),
    uid: z.number().int(),
    destination: z.string().describe('Target folder path.'),
    ...serverParam,
  },
  async execute(args, ctx) {
    const account = ctx.resolver.getServer(args.server as string | undefined);
    await ctx.imap
      .forAccount(account)
      .moveMessage((args.folder as string) ?? 'INBOX', args.uid as number, args.destination as string);
    return text(`Moved UID ${args.uid} to ${args.destination}.`);
  },
};

const emailFlag: Tool = {
  name: 'email_flag',
  title: 'Flag email',
  description: 'Flag or unflag (star/unstar) an email.',
  readOnly: false,
  inputSchema: {
    folder: z.string().default('INBOX'),
    uid: z.number().int(),
    flagged: z.boolean().default(true).describe('true = flag, false = unflag.'),
    ...serverParam,
  },
  async execute(args, ctx) {
    const account = ctx.resolver.getServer(args.server as string | undefined);
    const flagged = (args.flagged as boolean | undefined) ?? true;
    await ctx.imap
      .forAccount(account)
      .setFlags((args.folder as string) ?? 'INBOX', args.uid as number, { flagged });
    return text(`${flagged ? 'Flagged' : 'Unflagged'} UID ${args.uid}.`);
  },
};

function markTool(name: string, seen: boolean): Tool {
  const verb = seen ? 'read' : 'unread';
  return {
    name,
    title: `Mark email as ${verb}`,
    description: `Mark an email as ${verb} (${seen ? 'sets' : 'clears'} the \\Seen flag).`,
    readOnly: false,
    inputSchema: {
      folder: z.string().default('INBOX'),
      uid: z.number().int(),
      ...serverParam,
    },
    async execute(args, ctx) {
      const account = ctx.resolver.getServer(args.server as string | undefined);
      await ctx.imap
        .forAccount(account)
        .setFlags((args.folder as string) ?? 'INBOX', args.uid as number, { seen });
      return text(`Marked UID ${args.uid} as ${verb}.`);
    },
  };
}

const emailMarkRead = markTool('email_mark_read', true);
const emailMarkUnread = markTool('email_mark_unread', false);

function specialMoveTool(name: string, kind: 'junk' | 'archive'): Tool {
  const label = kind === 'junk' ? 'spam/junk' : 'archive';
  return {
    name,
    title: kind === 'junk' ? 'Mark as spam' : 'Archive email',
    description: `Move an email to the account's ${label} folder (special-use aware).`,
    readOnly: false,
    inputSchema: {
      folder: z.string().default('INBOX'),
      uid: z.number().int(),
      ...serverParam,
    },
    async execute(args, ctx) {
      const account = ctx.resolver.getServer(args.server as string | undefined);
      const target = await ctx.imap
        .forAccount(account)
        .moveToSpecialFolder((args.folder as string) ?? 'INBOX', args.uid as number, kind);
      return text(`Moved UID ${args.uid} to ${target}.`);
    },
  };
}

const emailMarkSpam = specialMoveTool('email_mark_spam', 'junk');
const emailArchive = specialMoveTool('email_archive', 'archive');

const emailCreateFolder: Tool = {
  name: 'email_create_folder',
  title: 'Create mail folder',
  description: 'Create a new IMAP folder. Use the delimiter of the account (usually "/") for nesting, e.g. "Projects/Acme".',
  readOnly: false,
  inputSchema: {
    path: z.string().describe('Folder path to create.'),
    ...serverParam,
  },
  async execute(args, ctx) {
    const account = ctx.resolver.getServer(args.server as string | undefined);
    await ctx.imap.forAccount(account).createFolder(args.path as string);
    return text(`Created folder ${args.path}.`);
  },
};

const emailDeleteFolder: Tool = {
  name: 'email_delete_folder',
  title: 'Delete mail folder',
  description: 'Delete an IMAP folder. The folder and its messages are removed — this cannot be undone.',
  readOnly: false,
  destructive: true,
  inputSchema: {
    path: z.string().describe('Folder path to delete.'),
    ...serverParam,
  },
  async execute(args, ctx) {
    const account = ctx.resolver.getServer(args.server as string | undefined);
    await ctx.imap.forAccount(account).deleteFolder(args.path as string);
    return text(`Deleted folder ${args.path}.`);
  },
};

// --- Mail filters (sieve) ---

const filterConditionSchema = z.object({
  field: z.enum(['from', 'to', 'subject', 'header']),
  header: z.string().optional().describe('Header name (required when field = "header").'),
  contains: z.string(),
});

const filterActionSchema = z.object({
  type: z.enum(['fileinto', 'discard', 'markRead', 'redirect']),
  folder: z.string().optional().describe('Target folder (required for "fileinto").'),
  address: z.string().optional().describe('Target address (required for "redirect").'),
});

const filterRuleShape = {
  name: z.string().describe('Human-readable rule name.'),
  conditions: z.array(filterConditionSchema).min(1),
  matchAll: z.boolean().optional().describe('true = all conditions must match (AND); default any (OR).'),
  action: filterActionSchema,
  stop: z.boolean().optional().describe('Stop processing further rules after this one matches.'),
};

function buildFilterInput(args: Record<string, unknown>) {
  return {
    name: args.name as string,
    conditions: args.conditions as { field: 'from' | 'to' | 'subject' | 'header'; header?: string; contains: string }[],
    matchAll: args.matchAll as boolean | undefined,
    action: args.action as { type: 'fileinto' | 'discard' | 'markRead' | 'redirect'; folder?: string; address?: string },
    stop: args.stop as boolean | undefined,
  };
}

const emailFilterList: Tool = {
  name: 'email_filter_list',
  title: 'List mail filters',
  description: 'List server-side mail filters managed by ox-mcp (sieve).',
  readOnly: true,
  inputSchema: { ...serverParam },
  async execute(args, ctx) {
    const account = ctx.resolver.getServer(args.server as string | undefined);
    return json(await ctx.sieve.forAccount(account).listFilters());
  },
};

const emailFilterCreate: Tool = {
  name: 'email_filter_create',
  title: 'Create mail filter',
  description:
    'Create a server-side mail filter (sieve). Note: ox-mcp manages its own sieve script and activates it.',
  readOnly: false,
  inputSchema: { ...filterRuleShape, ...serverParam },
  async execute(args, ctx) {
    const account = ctx.resolver.getServer(args.server as string | undefined);
    return json(await ctx.sieve.forAccount(account).createFilter(buildFilterInput(args)));
  },
};

const emailFilterUpdate: Tool = {
  name: 'email_filter_update',
  title: 'Update mail filter',
  description: 'Replace an existing ox-mcp mail filter by id (see email_filter_list).',
  readOnly: false,
  inputSchema: {
    id: z.string().describe('Filter id from email_filter_list.'),
    ...filterRuleShape,
    ...serverParam,
  },
  async execute(args, ctx) {
    const account = ctx.resolver.getServer(args.server as string | undefined);
    return json(await ctx.sieve.forAccount(account).updateFilter(args.id as string, buildFilterInput(args)));
  },
};

export const emailTools: Tool[] = [
  emailListFolders,
  emailList,
  emailRead,
  emailSearch,
  emailFilterList,
  emailSend,
  emailSaveDraft,
  emailReply,
  emailReplyAll,
  emailDelete,
  emailMove,
  emailFlag,
  emailMarkRead,
  emailMarkUnread,
  emailMarkSpam,
  emailArchive,
  emailCreateFolder,
  emailDeleteFolder,
  emailFilterCreate,
  emailFilterUpdate,
];
