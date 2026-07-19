import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleLogger } from '../../src/core/logger.js';

function captureStderr() {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, spy };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ConsoleLogger', () => {
  it('writes all levels to stderr at debug threshold', () => {
    const { lines } = captureStderr();
    const log = new ConsoleLogger('debug');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('DEBUG d');
    expect(lines[3]).toContain('ERROR e');
  });

  it('suppresses below the configured threshold', () => {
    const { lines } = captureStderr();
    const log = new ConsoleLogger('warn');
    log.debug('d');
    log.info('i');
    log.warn('w');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('WARN w');
  });

  it('serializes extra args including errors', () => {
    const { lines } = captureStderr();
    const log = new ConsoleLogger('info');
    log.info('with', { a: 1 }, 'str');
    expect(lines[0]).toContain('{"a":1}');
    expect(lines[0]).toContain('str');
  });

  it('silent level writes nothing', () => {
    const { lines } = captureStderr();
    const log = new ConsoleLogger('silent');
    log.error('nope');
    expect(lines).toHaveLength(0);
  });
});
