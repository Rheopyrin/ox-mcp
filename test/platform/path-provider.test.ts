import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  CONFIG_DIR_NAME,
  CONFIG_FILE_NAME,
  SCHEMA_FILE_NAME,
  PosixPathProvider,
  WindowsPathProvider,
} from '../../src/platform/path-provider.js';

describe('PosixPathProvider', () => {
  it('resolves config paths under ~/.ox-mcp', () => {
    const p = new PosixPathProvider(() => '/home/alice');
    expect(p.homeDir()).toBe('/home/alice');
    expect(p.configDir()).toBe(join('/home/alice', CONFIG_DIR_NAME));
    expect(p.configFile()).toBe(join('/home/alice', CONFIG_DIR_NAME, CONFIG_FILE_NAME));
    expect(p.schemaFile()).toBe(join('/home/alice', CONFIG_DIR_NAME, SCHEMA_FILE_NAME));
  });

  it('prefers $HOME when no resolver is injected', () => {
    const prev = process.env.HOME;
    process.env.HOME = '/home/bob';
    try {
      expect(new PosixPathProvider().homeDir()).toBe('/home/bob');
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
    }
  });
});

describe('WindowsPathProvider', () => {
  it('resolves config paths under the user profile', () => {
    const p = new WindowsPathProvider(() => 'C:\\Users\\Alice');
    expect(p.homeDir()).toBe('C:\\Users\\Alice');
    expect(p.configDir()).toBe(join('C:\\Users\\Alice', CONFIG_DIR_NAME));
    expect(p.configFile()).toContain(CONFIG_FILE_NAME);
  });

  it('prefers %USERPROFILE% when no resolver is injected', () => {
    const prev = process.env.USERPROFILE;
    process.env.USERPROFILE = 'C:\\Users\\Bob';
    try {
      expect(new WindowsPathProvider().homeDir()).toBe('C:\\Users\\Bob');
    } finally {
      if (prev === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prev;
    }
  });
});
