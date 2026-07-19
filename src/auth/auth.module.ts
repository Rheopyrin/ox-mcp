import { ContainerModule } from 'inversify';
import { TYPES } from '../core/types.js';
import { withTimeout } from '../core/http.js';
import { ConfigResolver } from '../config/config-resolver.js';
import type { Logger } from '../core/logger.js';
import { DefaultAuthProviderFactory, type AuthProviderFactory } from './auth-provider.js';
import { TokenManager } from './token-manager.js';

export const authModule = new ContainerModule((bind) => {
  bind<TokenManager>(TYPES.TokenManager)
    .toDynamicValue((ctx) => {
      const resolver = ctx.container.get<ConfigResolver>(TYPES.ConfigResolver);
      return new TokenManager(
        ctx.container.get<Logger>(TYPES.Logger),
        withTimeout(fetch, resolver.timeoutMs),
      );
    })
    .inSingletonScope();
  bind<AuthProviderFactory>(TYPES.AuthProviderFactory)
    .to(DefaultAuthProviderFactory)
    .inSingletonScope();
});
