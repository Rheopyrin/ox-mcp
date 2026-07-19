import { inject, injectable } from 'inversify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TYPES } from '../core/types.js';
import { SERVER_NAME, VERSION } from '../core/version.js';
import type { Logger } from '../core/logger.js';
import type { ToolRegistry } from '../tools/registry.js';

type RegisterTool = (
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  },
  cb: (args: Record<string, unknown>) => Promise<CallToolResult>,
) => void;

@injectable()
export class OxMcpServer {
  constructor(
    @inject(TYPES.ToolRegistry) private readonly registry: ToolRegistry,
    @inject(TYPES.Logger) private readonly logger: Logger,
  ) {}

  create(): McpServer {
    const server = new McpServer(
      { name: SERVER_NAME, version: VERSION },
      { capabilities: { tools: {} } },
    );
    const register = server.registerTool.bind(server) as unknown as RegisterTool;

    const visible = this.registry.visibleTools();
    for (const tool of visible) {
      register(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown>,
          annotations: {
            readOnlyHint: tool.readOnly,
            ...(tool.readOnly ? {} : { destructiveHint: tool.destructive ?? false }),
          },
        },
        async (args) => {
          const result = await this.registry.dispatch(tool.name, args ?? {});
          return { content: result.content, isError: result.isError };
        },
      );
    }
    this.logger.info(`Registered ${visible.length} tools: ${visible.map((t) => t.name).join(', ')}`);
    return server;
  }

  async start(): Promise<void> {
    const server = this.create();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    this.logger.info('ox-mcp is ready (stdio).');
  }
}
