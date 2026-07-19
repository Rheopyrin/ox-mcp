import { ContainerModule, inject, injectable } from 'inversify';
import { TYPES } from '../core/types.js';
import { withTimeout } from '../core/http.js';
import { ConfigResolver, requireSection, type ResolvedAccount } from '../config/config-resolver.js';
import type { Logger } from '../core/logger.js';
import type { AuthProviderFactory } from '../auth/auth-provider.js';
import type { FilterClient, MailboxClient, MailSenderClient } from './mail-backend.js';
import { ImapClient } from './imap-client.js';
import { SmtpClient } from './smtp-client.js';
import { SieveClient } from './sieve-client.js';
import { OxHttpMailClient } from './ox-http-client.js';
import { OxFilterClient } from './ox-filter-client.js';
import { OxSessionManager } from './ox-session.js';

export interface ImapClientFactory {
  forAccount(account: ResolvedAccount): MailboxClient;
}

export interface SmtpClientFactory {
  forAccount(account: ResolvedAccount): MailSenderClient;
}

export interface SieveClientFactory {
  forAccount(account: ResolvedAccount): FilterClient;
}

/**
 * Mailbox backend per section transport: direct IMAP by default, or the
 * Open-Xchange HTTP API when `mail.transport = "ox-api"`.
 */
@injectable()
export class DefaultImapClientFactory implements ImapClientFactory {
  constructor(
    @inject(TYPES.AuthProviderFactory) private readonly authFactory: AuthProviderFactory,
    @inject(TYPES.OxSessionManager) private readonly sessions: OxSessionManager,
    @inject(TYPES.ConfigResolver) private readonly resolver: ConfigResolver,
  ) {}
  forAccount(account: ResolvedAccount): MailboxClient {
    const section = requireSection(account, 'mail');
    if (section.transport === 'ox-api') {
      return new OxHttpMailClient(section, this.sessions, `${account.id}:mail`, withTimeout(fetch, this.resolver.timeoutMs));
    }
    return new ImapClient(
      section,
      this.authFactory.create(section.auth, `${account.id}:mail`),
      undefined,
      this.resolver.timeoutMs,
    );
  }
}

@injectable()
export class DefaultSmtpClientFactory implements SmtpClientFactory {
  constructor(
    @inject(TYPES.AuthProviderFactory) private readonly authFactory: AuthProviderFactory,
    @inject(TYPES.OxSessionManager) private readonly sessions: OxSessionManager,
    @inject(TYPES.ConfigResolver) private readonly resolver: ConfigResolver,
  ) {}
  forAccount(account: ResolvedAccount): MailSenderClient {
    const section = requireSection(account, 'mail');
    if (section.transport === 'ox-api') {
      return new OxHttpMailClient(section, this.sessions, `${account.id}:mail`, withTimeout(fetch, this.resolver.timeoutMs));
    }
    return new SmtpClient(
      section,
      this.authFactory.create(section.auth, `${account.id}:mail`),
      undefined,
      this.resolver.timeoutMs,
    );
  }
}

@injectable()
export class DefaultSieveClientFactory implements SieveClientFactory {
  constructor(
    @inject(TYPES.AuthProviderFactory) private readonly authFactory: AuthProviderFactory,
    @inject(TYPES.OxSessionManager) private readonly sessions: OxSessionManager,
    @inject(TYPES.ConfigResolver) private readonly resolver: ConfigResolver,
  ) {}
  forAccount(account: ResolvedAccount): FilterClient {
    const section = requireSection(account, 'mail');
    if (section.transport === 'ox-api') {
      return new OxFilterClient(section, this.sessions, `${account.id}:mail`, withTimeout(fetch, this.resolver.timeoutMs));
    }
    return new SieveClient(section, this.authFactory.create(section.auth, `${account.id}:mail`));
  }
}

export const mailModule = new ContainerModule((bind) => {
  bind<OxSessionManager>(TYPES.OxSessionManager)
    .toDynamicValue((ctx) => {
      const resolver = ctx.container.get<ConfigResolver>(TYPES.ConfigResolver);
      return new OxSessionManager(
        ctx.container.get<Logger>(TYPES.Logger),
        withTimeout(fetch, resolver.timeoutMs),
      );
    })
    .inSingletonScope();
  bind<ImapClientFactory>(TYPES.ImapClientFactory).to(DefaultImapClientFactory).inSingletonScope();
  bind<SmtpClientFactory>(TYPES.SmtpClientFactory).to(DefaultSmtpClientFactory).inSingletonScope();
  bind<SieveClientFactory>(TYPES.SieveClientFactory).to(DefaultSieveClientFactory).inSingletonScope();
});
