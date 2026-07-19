import { inject, injectable } from 'inversify';
import { TYPES } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import type { ConfigResolver } from '../config/config-resolver.js';
import type { ImapClientFactory, SieveClientFactory, SmtpClientFactory } from '../mail/mail.module.js';
import type { CalDavClientFactory, FreeBusyClientFactory } from '../calendar/calendar.module.js';
import type { CardDavClientFactory } from '../contacts/contacts.module.js';
import { errorResult, type Tool, type ToolContext, type ToolResult } from './tool.js';
import { serverTools } from './server-tools.js';
import { emailTools } from './email-tools.js';
import { calendarTools } from './calendar-tools.js';
import { contactTools } from './contact-tools.js';

/**
 * Owns the tool catalog. Advertises a tool only when its feature is enabled for
 * at least one account (ungated tools always show), and enforces the target
 * account's flag again at call time.
 */
@injectable()
export class ToolRegistry {
  private readonly tools: Tool[] = [...serverTools, ...emailTools, ...calendarTools, ...contactTools];

  constructor(
    @inject(TYPES.ConfigResolver) private readonly resolver: ConfigResolver,
    @inject(TYPES.ImapClientFactory) private readonly imap: ImapClientFactory,
    @inject(TYPES.SmtpClientFactory) private readonly smtp: SmtpClientFactory,
    @inject(TYPES.SieveClientFactory) private readonly sieve: SieveClientFactory,
    @inject(TYPES.CalDavClientFactory) private readonly caldav: CalDavClientFactory,
    @inject(TYPES.CardDavClientFactory) private readonly carddav: CardDavClientFactory,
    @inject(TYPES.FreeBusyClient) private readonly freeBusy: FreeBusyClientFactory,
    @inject(TYPES.Logger) private readonly logger: Logger,
  ) {}

  /** Tools to advertise (enabled for at least one account). */
  visibleTools(): Tool[] {
    return this.tools.filter((t) => this.resolver.isToolEnabledForAny(t.name));
  }

  getTool(name: string): Tool | undefined {
    return this.tools.find((t) => t.name === name);
  }

  /** Execute a tool with per-account enforcement and error trapping. */
  async dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.getTool(name);
    if (!tool) return errorResult(`Unknown tool "${name}".`);

    const serverId = (args.server as string | undefined) ?? this.resolver.defaultServerId;
    if (!this.resolver.hasServer(serverId)) {
      return errorResult(
        `Unknown server "${serverId}". Configured servers: ${this.resolver.serverIds().join(', ')}`,
      );
    }
    if (!this.resolver.isToolEnabled(name, serverId)) {
      return errorResult(
        `Tool "${name}" is disabled for server "${serverId}". Enable it via config.json features or OX_MCP_* env vars.`,
      );
    }

    try {
      return await tool.execute(args, this.context());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Tool "${name}" failed: ${message}`);
      return errorResult(`Tool "${name}" failed: ${message}`);
    }
  }

  private context(): ToolContext {
    return {
      resolver: this.resolver,
      imap: this.imap,
      smtp: this.smtp,
      sieve: this.sieve,
      caldav: this.caldav,
      carddav: this.carddav,
      freeBusy: this.freeBusy,
      logger: this.logger,
    };
  }
}
