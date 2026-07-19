import { ContainerModule, inject, injectable } from 'inversify';
import { TYPES } from '../core/types.js';
import { withTimeout } from '../core/http.js';
import { ConfigResolver, requireSection, type ResolvedAccount } from '../config/config-resolver.js';
import type { AuthProviderFactory } from '../auth/auth-provider.js';
import { CalDavClient, makeTsdavBackendFactory } from './caldav-client.js';
import { FreeBusyClient } from './freebusy-client.js';

export interface CalDavClientFactory {
  forAccount(account: ResolvedAccount): CalDavClient;
}

export interface FreeBusyClientFactory {
  forAccount(account: ResolvedAccount): FreeBusyClient;
}

@injectable()
export class DefaultCalDavClientFactory implements CalDavClientFactory {
  constructor(
    @inject(TYPES.AuthProviderFactory) private readonly authFactory: AuthProviderFactory,
    @inject(TYPES.ConfigResolver) private readonly resolver: ConfigResolver,
  ) {}
  forAccount(account: ResolvedAccount): CalDavClient {
    const section = requireSection(account, 'calDav');
    return new CalDavClient(
      section,
      this.authFactory.create(section.auth, `${account.id}:calDav`),
      makeTsdavBackendFactory(this.resolver.timeoutMs),
    );
  }
}

@injectable()
export class DefaultFreeBusyClientFactory implements FreeBusyClientFactory {
  constructor(
    @inject(TYPES.AuthProviderFactory) private readonly authFactory: AuthProviderFactory,
    @inject(TYPES.ConfigResolver) private readonly resolver: ConfigResolver,
  ) {}
  forAccount(account: ResolvedAccount): FreeBusyClient {
    const section = requireSection(account, 'calDav');
    return new FreeBusyClient(
      section,
      this.authFactory.create(section.auth, `${account.id}:calDav`),
      withTimeout(fetch, this.resolver.timeoutMs),
    );
  }
}

export const calendarModule = new ContainerModule((bind) => {
  bind<CalDavClientFactory>(TYPES.CalDavClientFactory)
    .to(DefaultCalDavClientFactory)
    .inSingletonScope();
  bind<FreeBusyClientFactory>(TYPES.FreeBusyClient)
    .to(DefaultFreeBusyClientFactory)
    .inSingletonScope();
});
