import { describe, expect, it } from 'vitest';
import { parseConfigPath } from '../../src/cli.js';

describe('parseConfigPath', () => {
  it('returns undefined with no arg and no env', () => {
    expect(parseConfigPath([], {})).toBeUndefined();
  });

  it('parses --config <path>', () => {
    expect(parseConfigPath(['--config', '/tmp/c.json'], {})).toBe('/tmp/c.json');
  });

  it('parses --config=<path>', () => {
    expect(parseConfigPath(['--config=/tmp/c.json'], {})).toBe('/tmp/c.json');
  });

  it('throws when --config has no value', () => {
    expect(() => parseConfigPath(['--config'], {})).toThrow(/requires a file path/);
    expect(() => parseConfigPath(['--config', '--other'], {})).toThrow(/requires a file path/);
    expect(() => parseConfigPath(['--config='], {})).toThrow(/requires a file path/);
  });

  it('falls back to OX_MCP_CONFIG env', () => {
    expect(parseConfigPath([], { OX_MCP_CONFIG: '/tmp/env.json' })).toBe('/tmp/env.json');
  });

  it('arg wins over env', () => {
    expect(parseConfigPath(['--config', '/tmp/arg.json'], { OX_MCP_CONFIG: '/tmp/env.json' })).toBe(
      '/tmp/arg.json',
    );
  });

  it('ignores blank env value', () => {
    expect(parseConfigPath([], { OX_MCP_CONFIG: '  ' })).toBeUndefined();
  });
});
