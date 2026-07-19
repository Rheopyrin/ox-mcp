import { inject, injectable } from 'inversify';
import { TYPES } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import type { PathProvider } from '../platform/path-provider.js';
import type { SecureFs } from '../platform/secure-fs.js';
import { buildDefaultConfig, buildJsonSchema, configSchema, type RawConfig } from './config.schema.js';

/**
 * Loads the config file and validates it against the zod schema.
 *
 * Default location `~/.ox-mcp/config.json` is created (reads on / writes off)
 * on first run. When a path override is provided (`--config` / `OX_MCP_CONFIG`)
 * the file MUST already exist — nothing is auto-created.
 */
@injectable()
export class ConfigLoader {
  constructor(
    @inject(TYPES.PathProvider) private readonly paths: PathProvider,
    @inject(TYPES.SecureFs) private readonly fs: SecureFs,
    @inject(TYPES.Logger) private readonly logger: Logger,
    @inject(TYPES.ConfigPathOverride) private readonly overridePath: string | undefined,
  ) {}

  async load(): Promise<RawConfig> {
    if (this.overridePath) {
      if (!(await this.fs.exists(this.overridePath))) {
        throw new Error(
          `Config file not found: ${this.overridePath} (a config passed via --config or OX_MCP_CONFIG is never auto-created)`,
        );
      }
      return this.parse(this.overridePath);
    }

    const file = this.paths.configFile();
    if (!(await this.fs.exists(file))) {
      await this.createDefault();
    }
    return this.parse(file);
  }

  private async parse(file: string): Promise<RawConfig> {

    const raw = await this.fs.readFile(file);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Invalid JSON in ${file}: ${(err as Error).message}`);
    }

    const parsed = configSchema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n');
      throw new Error(`Invalid config in ${file}:\n${issues}`);
    }
    return parsed.data;
  }

  private async createDefault(): Promise<void> {
    const file = this.paths.configFile();
    const schemaFile = this.paths.schemaFile();
    await this.fs.writeFileSecure(file, `${JSON.stringify(buildDefaultConfig(), null, 2)}\n`);
    await this.fs.writeFileSecure(schemaFile, `${JSON.stringify(buildJsonSchema(), null, 2)}\n`);
    this.logger.info(
      `Created default config at ${file}. All write tools are disabled — edit the file or set OX_MCP_* env vars to enable them.`,
    );
  }
}
