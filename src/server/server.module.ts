import { ContainerModule } from 'inversify';
import { TYPES } from '../core/types.js';
import { OxMcpServer } from './mcp-server.js';

export const serverModule = new ContainerModule((bind) => {
  bind<OxMcpServer>(TYPES.McpServer).to(OxMcpServer).inSingletonScope();
});
