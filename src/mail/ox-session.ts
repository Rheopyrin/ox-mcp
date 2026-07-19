import { inject, injectable } from 'inversify';
import { TYPES } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import type { ResolvedAuth } from '../config/config-resolver.js';

export type FetchFn = typeof fetch;

export interface OxSession {
  session: string;
  cookies: string;
}

interface LoginResponse {
  session?: string;
  error?: string;
  code?: string;
}

export interface OxApiTarget {
  host: string;
  auth: ResolvedAuth;
  contextId: string;
  sessions: OxSessionManager;
  fetchFn: FetchFn;
}

interface OxApiEnvelope<T> {
  data?: T;
  error?: string;
  code?: string;
}

/**
 * Perform an OX HTTP API request with the cached session; invalidates and
 * retries once when the API reports a `SES-*` (session expired) error.
 */
export async function oxApiRequest<T>(
  target: OxApiTarget,
  pathAndQuery: string,
  init: { method?: string; body?: string; rawBody?: boolean } = {},
  retried = false,
): Promise<T> {
  const { session, cookies } = await target.sessions.getSession(
    target.host,
    target.auth,
    target.contextId,
  );
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  // The OX HTTP API requires the session id as a query parameter (it is not
  // accepted as a header). It travels only over HTTPS and is never logged.
  const res = await target.fetchFn(
    `https://${target.host}/appsuite/api/${pathAndQuery}${sep}session=${session}`,
    {
      method: init.method ?? 'GET',
      headers: {
        cookie: cookies,
        ...(init.body !== undefined && {
          'content-type': init.rawBody ? 'text/plain; charset=utf-8' : 'application/json',
        }),
      },
      body: init.body,
    },
  );
  const text = await res.text();
  let json: OxApiEnvelope<T>;
  try {
    json = JSON.parse(text) as OxApiEnvelope<T>;
  } catch {
    throw new Error(`OX API returned a non-JSON response (HTTP ${res.status}): ${text.slice(0, 120)}`);
  }
  if (json.error) {
    if (!retried && json.code?.startsWith('SES-')) {
      target.sessions.invalidate(target.contextId);
      return oxApiRequest(target, pathAndQuery, init, true);
    }
    throw new Error(`OX API error${json.code ? ` [${json.code}]` : ''}: ${json.error}`);
  }
  return json.data as T;
}

/**
 * Acquires and caches Open-Xchange HTTP API sessions (the webmail backend's
 * `/appsuite/api/login` endpoint). This is where app passwords are validated
 * on OX deployments — servers like PrivateEmail honor scoped app passwords
 * here even when the raw IMAP layer rejects them.
 *
 * Sessions are cached per section context (`<accountId>:mail`); callers should
 * `invalidate()` and retry once when the API answers with a `SES-*` error.
 */
@injectable()
export class OxSessionManager {
  private readonly cache = new Map<string, OxSession>();

  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async getSession(host: string, auth: ResolvedAuth, contextId: string): Promise<OxSession> {
    const cached = this.cache.get(contextId);
    if (cached) return cached;
    const session = await this.login(host, auth, contextId);
    this.cache.set(contextId, session);
    return session;
  }

  invalidate(contextId: string): void {
    this.cache.delete(contextId);
  }

  private async login(host: string, auth: ResolvedAuth, contextId: string): Promise<OxSession> {
    if (auth.type !== 'basic') {
      throw new Error(
        `Section "${contextId}": the ox-api transport currently supports basic (app password) auth only.`,
      );
    }
    if (!auth.user || !auth.appPassword) {
      throw new Error(`Section "${contextId}" needs a login user and app password for the ox-api transport.`);
    }

    const res = await this.fetchFn(`https://${host}/appsuite/api/login?action=login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        name: auth.user,
        password: auth.appPassword,
        client: 'ox-mcp',
        version: '0.1.0',
        staySignedIn: 'true',
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`OX API login failed for "${contextId}" (HTTP ${res.status}).`);
    }
    const json = (await res.json()) as LoginResponse;
    if (!json.session) {
      throw new Error(`OX API login failed for "${contextId}": ${json.error ?? 'no session in response'}`);
    }
    const cookies = (res.headers.getSetCookie?.() ?? [])
      .map((cookie) => cookie.split(';')[0])
      .join('; ');
    this.logger.debug(`OX API session established for "${contextId}"`);
    return { session: json.session, cookies };
  }
}
