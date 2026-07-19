import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TIMEOUT_MS, withTimeout, type FetchFn } from '../../src/core/http.js';

const okResponse = { ok: true, status: 200 } as unknown as Response;

describe('withTimeout', () => {
  it('defaults to 300 seconds', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(300_000);
  });

  it('returns the original fetch when the timeout is non-positive (opt-out)', () => {
    const base = vi.fn() as unknown as FetchFn;
    expect(withTimeout(base, 0)).toBe(base);
    expect(withTimeout(base, -5)).toBe(base);
  });

  it('injects an AbortSignal and forwards the response on success', async () => {
    const base = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return okResponse;
    }) as unknown as FetchFn;
    const res = await withTimeout(base, 1000)('https://example.com');
    expect(res).toBe(okResponse);
  });

  it('remaps an AbortSignal.timeout abort to a clear error', async () => {
    const base = (async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    }) as unknown as FetchFn;
    await expect(withTimeout(base, 2000)('https://example.com')).rejects.toThrow(
      /timed out after 2s/,
    );
  });

  it('propagates non-timeout errors unchanged', async () => {
    const base = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as FetchFn;
    await expect(withTimeout(base, 2000)('https://example.com')).rejects.toThrow('ECONNREFUSED');
  });

  it("combines a caller's signal with the timeout signal", async () => {
    const controller = new AbortController();
    const base = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
      return okResponse;
    }) as unknown as FetchFn;
    await withTimeout(base, 1000)('https://example.com', { signal: controller.signal });
  });
});
