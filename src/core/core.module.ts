import { ContainerModule } from 'inversify';
import { TYPES } from './types.js';
import { ConsoleLogger, type Logger } from './logger.js';

export const coreModule = new ContainerModule((bind) => {
  // Bound via factory so the defaulted (env-driven) constructor arg is honored
  // instead of Inversify trying to inject the `level` primitive.
  bind<Logger>(TYPES.Logger)
    .toDynamicValue(() => new ConsoleLogger())
    .inSingletonScope();
});
