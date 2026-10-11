import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigLoader } from '../../src/config/config-loader.js';
import { PosixSecureFs } from '../../src/platform/secure-fs.js';
import type { PathProvider } from '../../src/platform/path-provider.js';
import type { Logger } from '../../src/core/logger.js';

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

class FakePathProvider implements PathProvider {
  constructor(private readonly dir: string) {}
  homeDir() {
    return this.dir;
  }
  configDir() {
    return join(this.dir, '.ox-mcp');
  }
  configFile() {
    return join(this.configDir(), 'config.json');
  }
  schemaFile() {
    return join(this.configDir(), 'config.schema.json');
  }
}

let dir: string;
let paths: FakePathProvider;
let loader: ConfigLoader;

function makeLoader(overridePath?: string): ConfigLoader {
  return new ConfigLoader(paths, new PosixSecureFs(), silentLogger, overridePath);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ox-mcp-loader-'));
  paths = new FakePathProvider(dir);
  loader = makeLoader();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ConfigLoader first run', () => {
  it('creates config.json with three sections, per-section flags, and 0600 perms', async () => {
    const config = await loader.load();
    const account = config.servers.default;

    expect(account.mail).toBeDefined();
    expect(account.calDav).toBeDefined();
    expect(account.cardDav).toBeDefined();
    expect(account.mail?.server).toBe('');
    expect(account.mail?.auth).toMatchObject({ type: 'basic', user: '' });
    expect(account.mail?.features?.search).toBe(true);
    expect(account.mail?.features?.send).toBe(false);
    expect(account.calDav?.features?.listEvents).toBe(true);
    expect(account.calDav?.features?.respondEvent).toBe(false);
    expect(account.cardDav?.features?.list).toBe(true);
    expect(account.cardDav?.features?.create).toBe(false);

    // Windows has no POSIX permission bits (stat always reports 0666).
    if (process.platform !== 'win32') {
      const mode = (await stat(paths.configFile())).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    // schema sibling written too
    expect(await readFile(paths.schemaFile(), 'utf8')).toContain('ox-mcp config');
  });

  it('is idempotent — second load does not overwrite edits', async () => {
    await loader.load();
    const edited = JSON.parse(await readFile(paths.configFile(), 'utf8'));
    edited.servers.default.mail.features.send = true;
    await writeFile(paths.configFile(), JSON.stringify(edited));

    const reloaded = await loader.load();
    expect(reloaded.servers.default.mail?.features?.send).toBe(true);
  });

  it('rejects invalid JSON with a helpful error', async () => {
    await loader.load();
    await writeFile(paths.configFile(), '{ not json');
    await expect(loader.load()).rejects.toThrow(/Invalid JSON/);
  });

  it('rejects a schema-invalid config', async () => {
    await loader.load();
    await writeFile(
      paths.configFile(),
      JSON.stringify({ servers: { x: { mail: { auth: { type: 'nope' } } } } }),
    );
    await expect(loader.load()).rejects.toThrow(/Invalid config/);
  });
});

describe('ConfigLoader with --config override', () => {
  it('loads the overridden file and never touches the default location', async () => {
    const custom = join(dir, 'custom.json');
    await writeFile(
      custom,
      JSON.stringify({
        servers: {
          work: {
            mail: { server: 'mail.example.com', auth: { type: 'basic', user: 'w@example.com', appPassword: 'x' } },
          },
        },
      }),
    );

    const config = await makeLoader(custom).load();
    expect(config.servers.work.mail?.auth).toMatchObject({ user: 'w@example.com' });
    expect(existsSync(paths.configDir())).toBe(false); // no ~/.ox-mcp created
  });

  it('errors when the overridden file is missing and creates nothing', async () => {
    const missing = join(dir, 'nope.json');
    await expect(makeLoader(missing).load()).rejects.toThrow(/Config file not found/);
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(paths.configDir())).toBe(false);
  });

  it('section enabled master switches are valid config', async () => {
    const custom = join(dir, 'bools.json');
    await writeFile(
      custom,
      JSON.stringify({
        servers: {
          default: {
            mail: { server: 'mail.example.com', enabled: true, auth: { type: 'basic', user: 'a@example.com', appPassword: 'x' } },
            calDav: { server: 'dav.example.com', enabled: false, auth: { type: 'basic', user: 'a@example.com', appPassword: 'y' } },
          },
        },
      }),
    );
    const config = await makeLoader(custom).load();
    expect(config.servers.default.calDav?.enabled).toBe(false);
  });
});
