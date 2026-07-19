import type { ResolvedMailSection } from '../config/config-resolver.js';
import type { MailboxClient, MailSenderClient } from './mail-backend.js';
import type {
  FolderInfo,
  MessageDetail,
  MessageSummary,
  SearchCriteria,
  SpecialFolderKind,
} from './imap-client.js';
import type { OutgoingMessage, SendResult } from './smtp-client.js';
import { oxApiRequest, type FetchFn, type OxSessionManager } from './ox-session.js';
import { buildMimeMessage } from './mime.js';

// OX mail flag bitmask (subset we use).
const FLAG_FLAGGED = 8;
const FLAG_SEEN = 32;

// Column ids for the mail module.
const COL = { id: 600, folder: 601, from: 603, to: 604, cc: 605, subject: 607, date: 610, flags: 611 } as const;
const LIST_COLUMNS = [COL.id, COL.folder, COL.from, COL.to, COL.cc, COL.subject, COL.date, COL.flags];
/** How many recent messages per folder a search scans (filtering is client-side). */
const SEARCH_SCAN_LIMIT = 200;

type OxAddress = [string | null, string];
type OxRow = unknown[];

const SPECIAL_FOLDER_NAMES: Record<SpecialFolderKind, string[]> = {
  junk: ['junk', 'spam', 'junk e-mail'],
  archive: ['archive', 'archives'],
};

/**
 * Mail backend over the Open-Xchange HTTP API (`/appsuite/api`) — the webmail
 * backend. Used when `mail.transport = "ox-api"`: OX deployments validate app
 * passwords at this middleware, so mail works even where raw IMAP rejects them.
 *
 * OX identifies folders as `default0/INBOX`-style ids; plain names (`INBOX`,
 * `Drafts`) are mapped automatically. Mail ids are the backing IMAP UIDs.
 */
export class OxHttpMailClient implements MailboxClient, MailSenderClient {
  constructor(
    private readonly section: ResolvedMailSection,
    private readonly sessions: OxSessionManager,
    private readonly contextId: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  // --- MailboxClient ---

  async listFolders(): Promise<FolderInfo[]> {
    const data = await this.request<unknown>(
      `folders?action=allVisible&content_type=mail&columns=1,300&tree=1`,
    );
    return flattenFolderRows(data).map(([id, title]) => ({
      path: String(id),
      name: String(title ?? id),
    }));
  }

  async listMessages(folder: string, limit = 25): Promise<MessageSummary[]> {
    const rows = await this.request<OxRow[]>(
      `mail?action=all&folder=${enc(this.oxFolder(folder))}&columns=${LIST_COLUMNS.join(',')}` +
        `&sort=${COL.date}&order=desc&limit=${limit}`,
    );
    return (rows ?? []).map((row) => toSummary(row));
  }

  async readMessage(folder: string, uid: number): Promise<MessageDetail | null> {
    let data: OxMailDetail | undefined;
    try {
      data = await this.request<OxMailDetail>(
        `mail?action=get&folder=${enc(this.oxFolder(folder))}&id=${enc(String(uid))}`,
      );
    } catch (err) {
      if (/MSG-0032|not found/i.test((err as Error).message)) return null;
      throw err;
    }
    if (!data) return null;
    return toDetail(data);
  }

  async search(
    folder: string | undefined,
    criteria: SearchCriteria,
    limit = 50,
  ): Promise<MessageSummary[]> {
    const folders = folder
      ? [this.oxFolder(folder)]
      : (await this.listFolders()).map((f) => f.path);
    const results: MessageSummary[] = [];
    for (const f of folders) {
      let summaries: MessageSummary[];
      try {
        summaries = await this.listMessages(f, SEARCH_SCAN_LIMIT);
      } catch {
        continue; // unreadable folder — skip, like the IMAP backend does
      }
      results.push(...summaries.filter((m) => matches(m, criteria)));
    }
    results.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    return results.slice(0, limit);
  }

  async setFlags(folder: string, uid: number, flags: { seen?: boolean; flagged?: boolean }): Promise<void> {
    const oxFolder = this.oxFolder(folder);
    const updates: { bits: number; value: boolean }[] = [];
    if (flags.seen !== undefined) updates.push({ bits: FLAG_SEEN, value: flags.seen });
    if (flags.flagged !== undefined) updates.push({ bits: FLAG_FLAGGED, value: flags.flagged });
    for (const u of updates) {
      await this.request(
        `mail?action=update&folder=${enc(oxFolder)}&id=${enc(String(uid))}`,
        { method: 'PUT', body: JSON.stringify({ flags: u.bits, value: u.value }) },
      );
    }
  }

  async moveMessage(folder: string, uid: number, destination: string): Promise<void> {
    await this.request(
      `mail?action=update&folder=${enc(this.oxFolder(folder))}&id=${enc(String(uid))}`,
      { method: 'PUT', body: JSON.stringify({ folder_id: this.oxFolder(destination) }) },
    );
  }

  async deleteMessage(folder: string, uid: number): Promise<void> {
    await this.request(`mail?action=delete&timestamp=${Date.now()}`, {
      method: 'PUT',
      body: JSON.stringify([{ id: String(uid), folder: this.oxFolder(folder) }]),
    });
  }

  async moveToSpecialFolder(folder: string, uid: number, kind: SpecialFolderKind): Promise<string> {
    const folders = await this.listFolders();
    const names = SPECIAL_FOLDER_NAMES[kind];
    const target =
      folders.find((f) => names.includes(f.name.toLowerCase())) ??
      folders.find((f) => names.includes(f.path.split('/').pop()?.toLowerCase() ?? ''));
    if (!target) {
      throw new Error(`No ${kind} folder found. Available: ${folders.map((f) => f.name).join(', ')}`);
    }
    await this.moveMessage(folder, uid, target.path);
    return target.path;
  }

  async createFolder(path: string): Promise<void> {
    const segments = path.split('/').filter(Boolean);
    const title = segments.pop() as string;
    const parent = segments.length > 0 ? this.oxFolder(segments.join('/')) : 'default0';
    await this.request(`folders?action=new&folder_id=${enc(parent)}&tree=1`, {
      method: 'PUT',
      body: JSON.stringify({ module: 'mail', title }),
    });
  }

  async deleteFolder(path: string): Promise<void> {
    await this.request(`folders?action=delete&tree=1&timestamp=${Date.now()}`, {
      method: 'PUT',
      body: JSON.stringify([this.oxFolder(path)]),
    });
  }

  async saveDraft(raw: string, folder = 'Drafts'): Promise<void> {
    // flags=4 marks the imported message as \Draft.
    await this.request(
      `mail?action=new&folder=${enc(this.oxFolder(folder))}&flags=4`,
      { method: 'PUT', body: raw, rawBody: true },
    );
  }

  // --- MailSenderClient ---

  async send(message: OutgoingMessage): Promise<SendResult> {
    const raw = await this.buildRaw(message);
    // PUT of a complete RFC822 message without a folder transports it.
    const data = await this.request<string>(`mail?action=new`, {
      method: 'PUT',
      body: raw,
      rawBody: true,
    });
    const to = Array.isArray(message.to) ? message.to : [message.to];
    return { messageId: typeof data === 'string' ? data : '', accepted: to.filter(Boolean), rejected: [] };
  }

  async buildRaw(message: OutgoingMessage): Promise<string> {
    return buildMimeMessage(this.section.auth.user, message);
  }

  // --- plumbing ---

  /** Map a plain folder name (INBOX, Drafts) onto an OX folder id. */
  private oxFolder(folder: string): string {
    return oxFolderId(folder);
  }

  private async request<T>(
    pathAndQuery: string,
    init: { method?: string; body?: string; rawBody?: boolean } = {},
  ): Promise<T> {
    return oxApiRequest<T>(
      {
        host: this.section.server,
        auth: this.section.auth,
        contextId: this.contextId,
        sessions: this.sessions,
        fetchFn: this.fetchFn,
      },
      pathAndQuery,
      init,
    );
  }
}

interface OxMailDetail {
  id: string;
  folder_id?: string;
  from?: OxAddress[];
  to?: OxAddress[];
  cc?: OxAddress[];
  subject?: string;
  received_date?: number;
  sent_date?: number;
  flags?: number;
  headers?: Record<string, unknown>;
  attachments?: { content_type?: string; content?: string }[];
}

function toSummary(row: OxRow): MessageSummary {
  const [id, folder, from, to, , subject, date, flags] = row as [
    string,
    string,
    OxAddress[] | undefined,
    OxAddress[] | undefined,
    OxAddress[] | undefined,
    string | undefined,
    number | undefined,
    number | undefined,
  ];
  return {
    uid: Number(id),
    folder,
    subject: subject ?? '(no subject)',
    from: formatAddresses(from),
    to: formatAddresses(to),
    date: date ? new Date(date).toISOString() : null,
    flags: flagNames(flags ?? 0),
    seen: ((flags ?? 0) & FLAG_SEEN) !== 0,
  };
}

function toDetail(data: OxMailDetail): MessageDetail {
  const text = data.attachments?.find((a) => a.content_type?.startsWith('text/plain'))?.content;
  const html = data.attachments?.find((a) => a.content_type?.startsWith('text/html'))?.content;
  const messageId = data.headers?.['Message-ID'] ?? data.headers?.['Message-Id'];
  return {
    uid: Number(data.id),
    folder: data.folder_id,
    subject: data.subject ?? '(no subject)',
    from: formatAddresses(data.from),
    to: formatAddresses(data.to),
    cc: data.cc?.length ? formatAddresses(data.cc) : undefined,
    date: data.received_date ? new Date(data.received_date).toISOString() : null,
    flags: flagNames(data.flags ?? 0),
    seen: ((data.flags ?? 0) & FLAG_SEEN) !== 0,
    messageId: typeof messageId === 'string' ? messageId : undefined,
    text: text ?? undefined,
    html: html ?? undefined,
    fromAddresses: bareAddresses(data.from),
    toAddresses: bareAddresses(data.to),
    ccAddresses: bareAddresses(data.cc),
  };
}

function formatAddresses(addresses: OxAddress[] | undefined): string {
  return (addresses ?? [])
    .map(([name, addr]) => (name ? `${name} <${addr}>` : addr))
    .join(', ');
}

function bareAddresses(addresses: OxAddress[] | undefined): string[] {
  return (addresses ?? []).map(([, addr]) => addr).filter(Boolean);
}

function flagNames(bits: number): string[] {
  const names: string[] = [];
  if (bits & FLAG_SEEN) names.push('\\Seen');
  if (bits & FLAG_FLAGGED) names.push('\\Flagged');
  return names;
}

/** `folders?action=allVisible` groups rows under private/public/shared. */
function flattenFolderRows(data: unknown): OxRow[] {
  if (Array.isArray(data)) return data as OxRow[];
  if (data && typeof data === 'object') {
    return Object.values(data as Record<string, unknown>)
      .filter(Array.isArray)
      .flat() as OxRow[];
  }
  return [];
}

function matches(m: MessageSummary, c: SearchCriteria): boolean {
  const has = (haystack: string | undefined, needle: string | undefined) =>
    needle === undefined || (haystack ?? '').toLowerCase().includes(needle.toLowerCase());
  if (!has(m.from, c.from)) return false;
  if (!has(m.to, c.to)) return false;
  if (!has(m.subject, c.subject)) return false;
  // Envelope-level fallback: the ox-api transport matches text/body against
  // subject+addresses (full-body search would require fetching every message).
  const envelope = `${m.subject} ${m.from} ${m.to}`;
  if (!has(envelope, c.text)) return false;
  if (!has(envelope, c.body)) return false;
  // A message with an unknown date is excluded from either bounded query.
  if (c.since && (m.date === null || m.date < new Date(c.since).toISOString())) return false;
  if (c.before && (m.date === null || m.date >= new Date(c.before).toISOString())) return false;
  if (c.seen !== undefined && m.seen !== c.seen) return false;
  if (c.flagged !== undefined && m.flags.includes('\\Flagged') !== c.flagged) return false;
  return true;
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

/** Map a plain folder name (INBOX, Drafts) onto an OX folder id (`default0/...`). */
export function oxFolderId(folder: string): string {
  return folder.startsWith('default') ? folder : `default0/${folder}`;
}
