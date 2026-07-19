import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import type { ResolvedMailSection } from '../config/config-resolver.js';
import type { AuthProvider } from '../auth/auth-provider.js';
import { DEFAULT_TIMEOUT_MS } from '../core/http.js';

export type ImapFlowFactory = (options: ImapFlowOptions) => ImapFlow;


export interface FolderInfo {
  path: string;
  name: string;
  specialUse?: string;
}

export interface MessageSummary {
  uid: number;
  folder?: string;
  subject: string;
  from: string;
  to: string;
  date: string | null;
  flags: string[];
  seen: boolean;
}

export interface MessageDetail extends MessageSummary {
  cc?: string;
  messageId?: string;
  text?: string;
  html?: string;
  /** Bare addresses for building replies. */
  fromAddresses: string[];
  toAddresses: string[];
  ccAddresses: string[];
}

export type SpecialFolderKind = 'junk' | 'archive';

export interface SearchCriteria {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  text?: string;
  since?: string;
  before?: string;
  seen?: boolean;
  flagged?: boolean;
}

/**
 * Thin IMAP wrapper over imapflow. Opens a fresh connection per operation
 * (operations are infrequent in an interactive MCP context) and always sets
 * `logger: false` so imapflow never writes to stdout and corrupts the MCP
 * JSON-RPC stream.
 */
export class ImapClient {
  constructor(
    private readonly section: ResolvedMailSection,
    private readonly authProvider: AuthProvider,
    private readonly flowFactory: ImapFlowFactory = (options) => new ImapFlow(options),
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async listFolders(): Promise<FolderInfo[]> {
    return this.withConnection(async (client) => {
      const list = await client.list();
      return list.map((f) => ({
        path: f.path,
        name: f.name,
        specialUse: f.specialUse,
      }));
    });
  }

  async listMessages(folder: string, limit = 25): Promise<MessageSummary[]> {
    return this.withConnection(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const total = client.mailbox && typeof client.mailbox !== 'boolean' ? client.mailbox.exists : 0;
        if (!total) return [];
        const start = Math.max(1, total - limit + 1);
        const summaries: MessageSummary[] = [];
        for await (const msg of client.fetch(`${start}:*`, { uid: true, envelope: true, flags: true })) {
          summaries.push(toSummary(msg.uid, msg.envelope, msg.flags));
        }
        return summaries.reverse(); // newest first
      } finally {
        lock.release();
      }
    });
  }

  async readMessage(folder: string, uid: number): Promise<MessageDetail | null> {
    return this.withConnection(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const msg = await client.fetchOne(
          String(uid),
          { uid: true, source: true, envelope: true, flags: true },
          { uid: true },
        );
        if (!msg || !msg.source) return null;
        const parsed = await simpleParser(msg.source);
        const summary = toSummary(msg.uid, msg.envelope, msg.flags);
        return {
          ...summary,
          folder,
          cc: formatAddress(parsed.cc),
          messageId: parsed.messageId,
          text: parsed.text ?? undefined,
          html: typeof parsed.html === 'string' ? parsed.html : undefined,
          fromAddresses: bareAddresses(parsed.from),
          toAddresses: bareAddresses(parsed.to),
          ccAddresses: bareAddresses(parsed.cc),
        };
      } finally {
        lock.release();
      }
    });
  }

  /**
   * Search messages. When `folder` is omitted, searches every selectable
   * folder and returns the newest matches across all of them.
   */
  async search(
    folder: string | undefined,
    criteria: SearchCriteria,
    limit = 50,
  ): Promise<MessageSummary[]> {
    return this.withConnection(async (client) => {
      const query = toSearchQuery(criteria);
      if (folder) {
        return this.searchFolder(client, folder, query, limit);
      }
      const folders = await client.list();
      const results: MessageSummary[] = [];
      for (const f of folders) {
        if (f.flags?.has?.('\\Noselect')) continue;
        try {
          results.push(...(await this.searchFolder(client, f.path, query, limit)));
        } catch {
          // Skip folders that cannot be opened (permissions, virtual folders).
        }
      }
      results.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
      return results.slice(0, limit);
    });
  }

  private async searchFolder(
    client: ImapFlow,
    folder: string,
    query: Record<string, unknown>,
    limit: number,
  ): Promise<MessageSummary[]> {
    const lock = await client.getMailboxLock(folder);
    try {
      const uids = await client.search(query, { uid: true });
      if (!uids || uids.length === 0) return [];
      const selected = uids.slice(-limit);
      const summaries: MessageSummary[] = [];
      for await (const msg of client.fetch(
        selected,
        { uid: true, envelope: true, flags: true },
        { uid: true },
      )) {
        summaries.push({ ...toSummary(msg.uid, msg.envelope, msg.flags), folder });
      }
      return summaries.reverse();
    } finally {
      lock.release();
    }
  }

  /** Move a message to the account's Junk or Archive folder (special-use aware). */
  async moveToSpecialFolder(
    fromFolder: string,
    uid: number,
    kind: SpecialFolderKind,
  ): Promise<string> {
    return this.withConnection(async (client) => {
      const folders = await client.list();
      const specialUse = kind === 'junk' ? '\\Junk' : '\\Archive';
      const fallbacks =
        kind === 'junk' ? ['junk', 'spam', 'junk e-mail'] : ['archive', 'archives'];
      const target =
        folders.find((f) => f.specialUse === specialUse) ??
        folders.find((f) => fallbacks.includes(f.name.toLowerCase())) ??
        folders.find((f) => fallbacks.includes(f.path.toLowerCase()));
      if (!target) {
        throw new Error(
          `No ${kind} folder found on this account. Available: ${folders.map((f) => f.path).join(', ')}`,
        );
      }
      const lock = await client.getMailboxLock(fromFolder);
      try {
        await client.messageMove(String(uid), target.path, { uid: true });
      } finally {
        lock.release();
      }
      return target.path;
    });
  }

  async setFlags(
    folder: string,
    uid: number,
    changes: { seen?: boolean; flagged?: boolean },
  ): Promise<void> {
    await this.withConnection(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const add: string[] = [];
        const remove: string[] = [];
        if (changes.seen === true) add.push('\\Seen');
        if (changes.seen === false) remove.push('\\Seen');
        if (changes.flagged === true) add.push('\\Flagged');
        if (changes.flagged === false) remove.push('\\Flagged');
        if (add.length) await client.messageFlagsAdd(String(uid), add, { uid: true });
        if (remove.length) await client.messageFlagsRemove(String(uid), remove, { uid: true });
      } finally {
        lock.release();
      }
    });
  }

  async moveMessage(folder: string, uid: number, destination: string): Promise<void> {
    await this.withConnection(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        await client.messageMove(String(uid), destination, { uid: true });
      } finally {
        lock.release();
      }
    });
  }

  async deleteMessage(folder: string, uid: number): Promise<void> {
    await this.withConnection(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        await client.messageDelete(String(uid), { uid: true });
      } finally {
        lock.release();
      }
    });
  }

  async createFolder(path: string): Promise<void> {
    await this.withConnection(async (client) => {
      await client.mailboxCreate(path);
    });
  }

  async deleteFolder(path: string): Promise<void> {
    await this.withConnection(async (client) => {
      await client.mailboxDelete(path);
    });
  }

  async saveDraft(raw: string, folder = 'Drafts'): Promise<void> {
    await this.withConnection(async (client) => {
      await client.append(folder, raw, ['\\Draft']);
    });
  }

  private async withConnection<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const auth = await this.authProvider.getImapAuth();
    const client = this.flowFactory({
      host: this.section.imap.host,
      port: this.section.imap.port,
      secure: this.section.imap.secure,
      auth,
      logger: false,
      // Bound the connect handshake and per-command idle so a stalled server
      // cannot hang the MCP session indefinitely.
      connectionTimeout: this.timeoutMs,
      greetingTimeout: this.timeoutMs,
      socketTimeout: this.timeoutMs,
    });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => undefined);
    }
  }
}

type Envelope = {
  subject?: string;
  date?: Date | string;
  from?: { name?: string; address?: string }[];
  to?: { name?: string; address?: string }[];
} | undefined;

function toSummary(uid: number, envelope: Envelope, flags: Set<string> | undefined): MessageSummary {
  const flagList = flags ? [...flags] : [];
  return {
    uid,
    subject: envelope?.subject ?? '(no subject)',
    from: formatEnvelopeAddresses(envelope?.from),
    to: formatEnvelopeAddresses(envelope?.to),
    date: envelope?.date ? new Date(envelope.date).toISOString() : null,
    flags: flagList,
    seen: flagList.includes('\\Seen'),
  };
}

function formatEnvelopeAddresses(
  addresses: { name?: string; address?: string }[] | undefined,
): string {
  if (!addresses || addresses.length === 0) return '';
  return addresses
    .map((a) => (a.name ? `${a.name} <${a.address ?? ''}>` : (a.address ?? '')))
    .filter(Boolean)
    .join(', ');
}

function formatAddress(address: AddressObject | AddressObject[] | undefined): string | undefined {
  if (!address) return undefined;
  const list = Array.isArray(address) ? address : [address];
  const text = list.map((a) => a.text).filter(Boolean).join(', ');
  return text || undefined;
}

function bareAddresses(address: AddressObject | AddressObject[] | undefined): string[] {
  if (!address) return [];
  const list = Array.isArray(address) ? address : [address];
  return list.flatMap((a) => a.value.map((v) => v.address ?? '')).filter(Boolean);
}

function toSearchQuery(criteria: SearchCriteria): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  if (criteria.from) query.from = criteria.from;
  if (criteria.to) query.to = criteria.to;
  if (criteria.subject) query.subject = criteria.subject;
  if (criteria.body) query.body = criteria.body;
  if (criteria.text) query.text = criteria.text;
  if (criteria.since) query.since = new Date(criteria.since);
  if (criteria.before) query.before = new Date(criteria.before);
  if (criteria.seen !== undefined) query.seen = criteria.seen;
  if (criteria.flagged !== undefined) query.flagged = criteria.flagged;
  // Default to returning everything when no criteria were supplied.
  if (Object.keys(query).length === 0) query.all = true;
  return query;
}
