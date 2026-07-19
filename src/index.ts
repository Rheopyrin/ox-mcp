import 'reflect-metadata';
import { buildContainer } from './container.js';
import { parseConfigPath } from './cli.js';
import { TYPES } from './core/types.js';
import type { OxMcpServer } from './server/mcp-server.js';

async function main(): Promise<void> {
  const configPath = parseConfigPath(process.argv.slice(2));
  const container = await buildContainer(process.env, { configPath });
  const server = container.get<OxMcpServer>(TYPES.McpServer);
  await server.start();
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`[ox-mcp] FATAL ${message}\n`);
  process.exit(1);
});
