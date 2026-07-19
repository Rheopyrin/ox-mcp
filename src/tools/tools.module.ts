import { ContainerModule } from 'inversify';
import { TYPES } from '../core/types.js';
import { ToolRegistry } from './registry.js';

export const toolsModule = new ContainerModule((bind) => {
  bind<ToolRegistry>(TYPES.ToolRegistry).to(ToolRegistry).inSingletonScope();
});
