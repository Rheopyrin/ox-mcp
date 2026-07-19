import type {
  FolderInfo,
  MessageDetail,
  MessageSummary,
  SearchCriteria,
  SpecialFolderKind,
} from './imap-client.js';
import type { OutgoingMessage, SendResult } from './smtp-client.js';
import type { FilterRule, FilterRuleInput } from './sieve-client.js';

/**
 * Mailbox operations behind the email_* tools. Implemented by `ImapClient`
 * (direct IMAP) and `OxHttpMailClient` (Open-Xchange HTTP API).
 */
export interface MailboxClient {
  listFolders(): Promise<FolderInfo[]>;
  listMessages(folder: string, limit?: number): Promise<MessageSummary[]>;
  readMessage(folder: string, uid: number): Promise<MessageDetail | null>;
  search(folder: string | undefined, criteria: SearchCriteria, limit?: number): Promise<MessageSummary[]>;
  setFlags(folder: string, uid: number, flags: { seen?: boolean; flagged?: boolean }): Promise<void>;
  moveMessage(folder: string, uid: number, destination: string): Promise<void>;
  deleteMessage(folder: string, uid: number): Promise<void>;
  moveToSpecialFolder(folder: string, uid: number, kind: SpecialFolderKind): Promise<string>;
  createFolder(path: string): Promise<void>;
  deleteFolder(path: string): Promise<void>;
  saveDraft(raw: string, folder?: string): Promise<void>;
}

/** Outgoing-mail operations. Implemented by `SmtpClient` and `OxHttpMailClient`. */
export interface MailSenderClient {
  send(message: OutgoingMessage): Promise<SendResult>;
  buildRaw(message: OutgoingMessage): Promise<string>;
}

/**
 * Mail filter operations behind the email_filter_* tools. Implemented by
 * `SieveClient` (direct ManageSieve) and `OxFilterClient` (OX mailfilter/v2).
 */
export interface FilterClient {
  listFilters(): Promise<FilterRule[]>;
  createFilter(input: FilterRuleInput): Promise<FilterRule>;
  updateFilter(id: string, input: FilterRuleInput): Promise<FilterRule>;
}
