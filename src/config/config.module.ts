import { ContainerModule } from 'inversify';
import { TYPES } from '../core/types.js';
import { ConfigLoader } from './config-loader.js';

/**
 * Binds the config loader. The resolved config (`ConfigResolver`) is built
 * during async bootstrap (after first-run file creation) and bound there.
 */
export const configModule = new ContainerModule((bind) => {
  bind<ConfigLoader>(TYPES.ConfigLoader).to(ConfigLoader).inSingletonScope();
});
