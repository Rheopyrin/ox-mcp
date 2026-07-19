import { z, type ZodRawShape } from 'zod';
import type { Logger } from '../core/logger.js';
import type { ConfigResolver } from '../config/config-resolver.js';
import type { ImapClientFactory, SieveClientFactory, SmtpClientFactory } from '../mail/mail.module.js';
import type { CalDavClientFactory, FreeBusyClientFactory } from '../calendar/calendar.module.js';
import type { CardDavClientFactory } from '../contacts/contacts.module.js';

export interface ToolContext {
  resolver: ConfigResolver;
  imap: ImapClientFactory;
  smtp: SmtpClientFactory;
  sieve: SieveClientFactory;
  caldav: CalDavClientFactory;
  carddav: CardDavClientFactory;
  freeBusy: FreeBusyClientFactory;
  logger: Logger;
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/**
 * A tool's feature gating is resolved by name via `FEATURE_BY_TOOL`
 * (src/config/features.ts); tools without a feature entry are always visible.
 */
export interface Tool {
  name: string;
  title?: string;
  description: string;
  readOnly: boolean;
  /** Irreversibly removes data (delete). Surfaced as MCP `destructiveHint`. */
  destructive?: boolean;
  inputSchema: ZodRawShape;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Optional `server` selector present on every tool except list_servers. */
export const serverParam = {
  server: z
    .string()
    .optional()
    .describe('Server/account id to target. Defaults to the configured default server.'),
};

export function text(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }] };
}

export function json(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
