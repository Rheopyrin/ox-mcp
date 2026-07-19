import { describe, expect, it } from 'vitest';
import {
  extractScriptContent,
  findResponseEnd,
  parseListScripts,
} from '../../src/mail/sieve-transport.js';

describe('findResponseEnd', () => {
  it('returns -1 until a terminating line arrives', () => {
    expect(findResponseEnd('')).toBe(-1);
    expect(findResponseEnd('"partial line without CRLF')).toBe(-1);
    expect(findResponseEnd('OK "no crlf yet"')).toBe(-1);
  });

  it('terminates on OK/NO/BYE and returns the index just past it', () => {
    const buf = 'OK "done"\r\n';
    expect(findResponseEnd(buf)).toBe(buf.length);
    expect(findResponseEnd('NO "err"\r\n')).toBe('NO "err"\r\n'.length);
    expect(findResponseEnd('BYE "gone"\r\n')).toBe('BYE "gone"\r\n'.length);
  });

  it('skips data lines before the terminator', () => {
    const buf = '"script1"\r\n"script2" ACTIVE\r\nOK\r\n';
    expect(findResponseEnd(buf)).toBe(buf.length);
  });

  it('does not treat a literal payload as a terminator (honors {n})', () => {
    // The literal body "NO everywhere\r\n" must not be mistaken for a NO line.
    const body = 'NO everywhere\r\n';
    const buf = `{${Buffer.byteLength(body)}}\r\n${body}OK\r\n`;
    // Should terminate only at the trailing OK, past the whole literal.
    expect(findResponseEnd(buf)).toBe(buf.length);
  });

  it('handles the non-synchronizing literal form {n+}', () => {
    const body = 'if true {\r\n  stop;\r\n}\r\n';
    const buf = `{${Buffer.byteLength(body)}+}\r\n${body}OK "stored"\r\n`;
    expect(findResponseEnd(buf)).toBe(buf.length);
  });

  it('returns -1 when a literal is announced but not yet fully buffered', () => {
    const buf = '{50}\r\nonly a few bytes';
    expect(findResponseEnd(buf)).toBe(-1);
  });

  it('leaves trailing bytes of the next response untouched', () => {
    const first = 'OK "one"\r\n';
    const buf = `${first}"leftover"`;
    expect(findResponseEnd(buf)).toBe(first.length);
  });
});

describe('parseListScripts', () => {
  it('parses names and the ACTIVE marker', () => {
    const res = '"ox-mcp" ACTIVE\r\n"vacation"\r\nOK\r\n';
    expect(parseListScripts(res)).toEqual([
      { name: 'ox-mcp', active: true },
      { name: 'vacation', active: false },
    ]);
  });

  it('unescapes quoted characters in names', () => {
    expect(parseListScripts('"a\\"b"\r\nOK\r\n')).toEqual([{ name: 'a"b', active: false }]);
  });

  it('returns an empty list when there are no scripts', () => {
    expect(parseListScripts('OK "no scripts"\r\n')).toEqual([]);
  });
});

describe('extractScriptContent', () => {
  it('extracts exactly n bytes of the literal body', () => {
    const body = '# ox-mcp\r\nif true { stop; }\r\n';
    const res = `{${Buffer.byteLength(body)}}\r\n${body}\r\nOK\r\n`;
    expect(extractScriptContent(res)).toBe(body);
  });

  it('supports the {n+} literal form', () => {
    const body = 'discard;';
    const res = `{${Buffer.byteLength(body)}+}\r\n${body}\r\nOK\r\n`;
    expect(extractScriptContent(res)).toBe(body);
  });

  it('returns undefined when the response has no literal', () => {
    expect(extractScriptContent('OK "empty"\r\n')).toBeUndefined();
  });
});
