import { Container } from 'inversify';
import { TYPES } from './core/types.js';
import { coreModule } from './core/core.module.js';
import { platformModule } from './platform/platform.module.js';
import { configModule } from './config/config.module.js';
import { ConfigLoader } from './config/config-loader.js';
import { ConfigResolver } from './config/config-resolver.js';
import { authModule } from './auth/auth.module.js';
import { mailModule } from './mail/mail.module.js';
import { calendarModule } from './calendar/calendar.module.js';
import { contactsModule } from './contacts/contacts.module.js';
import { toolsModule } from './tools/tools.module.js';
import { serverModule } from './server/server.module.js';
import type { Env } from './config/env.js';

export interface ContainerOptions {
  /** Config file path override (--config / OX_MCP_CONFIG); must exist if set. */
  configPath?: string;
}

/**
 * Compose the DI container. Loads config (creating the default file on first
 * run unless a path override is given), validates the effective configuration
 * strictly (enabled feature groups must have their required hosts), and binds
 * the resolver before returning.
 */
export async function buildContainer(
  env: Env = process.env,
  options: ContainerOptions = {},
): Promise<Container> {
  const container = new Container({ defaultScope: 'Singleton' });
  container.load(
    coreModule,
    platformModule,
    configModule,
    authModule,
    mailModule,
    calendarModule,
    contactsModule,
    toolsModule,
    serverModule,
  );
  container
    .bind<string | undefined>(TYPES.ConfigPathOverride)
    .toConstantValue(options.configPath);

  const loader = container.get<ConfigLoader>(TYPES.ConfigLoader);
  const rawConfig = await loader.load();
  const resolver = new ConfigResolver(rawConfig, env);
  resolver.validate();
  container.bind<ConfigResolver>(TYPES.ConfigResolver).toConstantValue(resolver);

  return container;
}
