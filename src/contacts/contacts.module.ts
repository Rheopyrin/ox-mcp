import { ContainerModule, inject, injectable } from 'inversify';
import { TYPES } from '../core/types.js';
import { ConfigResolver, requireSection, type ResolvedAccount } from '../config/config-resolver.js';
import type { AuthProviderFactory } from '../auth/auth-provider.js';
import { CardDavClient, makeCardDavBackendFactory } from './carddav-client.js';

export interface CardDavClientFactory {
  forAccount(account: ResolvedAccount): CardDavClient;
}

@injectable()
export class DefaultCardDavClientFactory implements CardDavClientFactory {
  constructor(
    @inject(TYPES.AuthProviderFactory) private readonly authFactory: AuthProviderFactory,
    @inject(TYPES.ConfigResolver) private readonly resolver: ConfigResolver,
  ) {}
  forAccount(account: ResolvedAccount): CardDavClient {
    const section = requireSection(account, 'cardDav');
    return new CardDavClient(
      section,
      this.authFactory.create(section.auth, `${account.id}:cardDav`),
      makeCardDavBackendFactory(this.resolver.timeoutMs),
    );
  }
}

export const contactsModule = new ContainerModule((bind) => {
  bind<CardDavClientFactory>(TYPES.CardDavClientFactory)
    .to(DefaultCardDavClientFactory)
    .inSingletonScope();
});
