import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PosixSecureFs, WindowsSecureFs } from '../../src/platform/secure-fs.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ox-mcp-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('PosixSecureFs', () => {
  it('reports existence correctly', async () => {
    const fs = new PosixSecureFs();
    const file = join(dir, 'sub', 'config.json');
    expect(await fs.exists(file)).toBe(false);
    await fs.writeFileSecure(file, '{}');
    expect(await fs.exists(file)).toBe(true);
  });

  it('writes files 0600 and dirs 0700 and round-trips content', async () => {
    const fs = new PosixSecureFs();
    const file = join(dir, 'nested', 'config.json');
    await fs.writeFileSecure(file, '{"a":1}');

    expect(await fs.readFile(file)).toBe('{"a":1}');
    const fileMode = (await stat(file)).mode & 0o777;
    const dirMode = (await stat(join(dir, 'nested'))).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });
});

describe('WindowsSecureFs', () => {
  it('writes and reads without enforcing POSIX modes', async () => {
    const fs = new WindowsSecureFs();
    const file = join(dir, 'win', 'config.json');
    await fs.writeFileSecure(file, 'hello');
    expect(await fs.exists(file)).toBe(true);
    expect(await fs.readFile(file)).toBe('hello');
  });
});
