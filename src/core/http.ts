export type FetchFn = typeof fetch;

/** Default network timeout applied to every request when config sets none. */
export const DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_TIMEOUT_SECONDS = DEFAULT_TIMEOUT_MS / 1000;

/**
 * Wrap a fetch function so every request aborts after `timeoutMs`. A fresh
 * `AbortSignal.timeout` is minted per call, so the budget is per-request (not
 * shared across a wrapped client). Any caller-supplied signal is preserved.
 *
 * A non-positive or non-finite timeout disables the wrapper (returns the
 * original fetch) so `0` can be used to opt out.
 */
export function withTimeout(fetchFn: FetchFn = fetch, timeoutMs: number = DEFAULT_TIMEOUT_MS): FetchFn {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fetchFn;
  return (async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]): Promise<Response> => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    try {
      return await fetchFn(input, { ...init, signal });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
      }
      throw err;
    }
  }) as FetchFn;
}
