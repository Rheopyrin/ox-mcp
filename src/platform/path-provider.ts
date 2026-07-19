import { injectable } from 'inversify';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONFIG_DIR_NAME = '.ox-mcp';
export const CONFIG_FILE_NAME = 'config.json';
export const SCHEMA_FILE_NAME = 'config.schema.json';

/**
 * Resolves the on-disk locations the server uses. The config directory is
 * `~/.ox-mcp` on every platform (per product requirement); the per-OS
 * implementations differ only in how the home directory is discovered.
 */
export interface PathProvider {
  homeDir(): string;
  configDir(): string;
  configFile(): string;
  schemaFile(): string;
}

abstract class BasePathProvider implements PathProvider {
  abstract homeDir(): string;

  configDir(): string {
    return join(this.homeDir(), CONFIG_DIR_NAME);
  }

  configFile(): string {
    return join(this.configDir(), CONFIG_FILE_NAME);
  }

  schemaFile(): string {
    return join(this.configDir(), SCHEMA_FILE_NAME);
  }
}

/** Linux/macOS: prefer $HOME, fall back to os.homedir(). */
@injectable()
export class PosixPathProvider extends BasePathProvider {
  constructor(private readonly resolveHome: () => string = () => process.env.HOME || homedir()) {
    super();
  }

  override homeDir(): string {
    return this.resolveHome();
  }
}

/** Windows: prefer %USERPROFILE%, fall back to os.homedir(). */
@injectable()
export class WindowsPathProvider extends BasePathProvider {
  constructor(
    private readonly resolveHome: () => string = () => process.env.USERPROFILE || homedir(),
  ) {
    super();
  }

  override homeDir(): string {
    return this.resolveHome();
  }
}
