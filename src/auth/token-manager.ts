import { inject, injectable } from 'inversify';
import { TYPES } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import type { ResolvedAuth } from '../config/config-resolver.js';

export type FetchFn = typeof fetch;

interface CachedToken {
  accessToken: string;
  /** epoch ms, or Infinity for non-expiring (static) tokens */
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  token_type?: string;
}

const EXPIRY_SKEW_MS = 30_000;

/**
 * Acquires and caches OAuth access tokens per account. Supports static tokens
 * (`xoauth2`), refresh-token and password grants (`oauth2-*`), and OIDC
 * (discovers the token endpoint from the issuer, then a refresh/password grant).
 *
 * Uses a plain token-endpoint POST via `fetch` so there is no OAuth-library
 * version coupling and the whole thing is trivially mockable in tests.
 */
@injectable()
export class TokenManager {
  private readonly cache = new Map<string, CachedToken>();

  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  /** `contextId` identifies the section (`<accountId>:<section>`) for caching and errors. */
  async getAccessToken(auth: ResolvedAuth, contextId: string): Promise<string> {
    const cached = this.cache.get(contextId);
    if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
      return cached.accessToken;
    }
    const token = await this.acquire(auth, contextId);
    this.cache.set(contextId, token);
    return token.accessToken;
  }

  /** Test/maintenance helper. */
  clear(contextId?: string): void {
    if (contextId) this.cache.delete(contextId);
    else this.cache.clear();
  }

  private async acquire(auth: ResolvedAuth, contextId: string): Promise<CachedToken> {
    switch (auth.type) {
      case 'xoauth2': {
        if (!auth.accessToken) {
          throw new Error(`Section "${contextId}" (xoauth2) has no access token.`);
        }
        return { accessToken: auth.accessToken, expiresAt: Infinity };
      }
      case 'oauth2-refresh':
        return this.tokenEndpointGrant(contextId, auth.tokenUrl, this.refreshParams(auth));
      case 'oauth2-password':
        return this.tokenEndpointGrant(contextId, auth.tokenUrl, this.passwordParams(auth));
      case 'oidc': {
        const tokenUrl = await this.discoverTokenEndpoint(auth.issuer);
        const params = auth.refreshToken
          ? this.refreshParams({
              clientId: auth.clientId,
              clientSecret: auth.clientSecret,
              refreshToken: auth.refreshToken,
              scope: auth.scope,
            })
          : this.passwordParams({
              clientId: auth.clientId,
              clientSecret: auth.clientSecret,
              password: auth.password ?? '',
              user: auth.user,
              scope: auth.scope,
            });
        return this.tokenEndpointGrant(contextId, tokenUrl, params);
      }
      default:
        throw new Error(`Auth type "${(auth as ResolvedAuth).type}" does not use tokens.`);
    }
  }

  private refreshParams(a: {
    clientId: string;
    clientSecret?: string;
    refreshToken: string;
    scope?: string;
  }): URLSearchParams {
    const p = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: a.refreshToken });
    if (a.clientId) p.set('client_id', a.clientId);
    if (a.clientSecret) p.set('client_secret', a.clientSecret);
    if (a.scope) p.set('scope', a.scope);
    return p;
  }

  private passwordParams(a: {
    clientId: string;
    clientSecret?: string;
    password: string;
    user: string;
    scope?: string;
  }): URLSearchParams {
    const p = new URLSearchParams({
      grant_type: 'password',
      username: a.user,
      password: a.password,
    });
    if (a.clientId) p.set('client_id', a.clientId);
    if (a.clientSecret) p.set('client_secret', a.clientSecret);
    if (a.scope) p.set('scope', a.scope);
    return p;
  }

  private async tokenEndpointGrant(
    accountId: string,
    tokenUrl: string,
    body: URLSearchParams,
  ): Promise<CachedToken> {
    if (!tokenUrl) {
      throw new Error(`Account "${accountId}" is missing a token endpoint URL.`);
    }
    const res = await this.fetchFn(tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await safeText(res);
      throw new Error(`Token request for "${accountId}" failed (${res.status}): ${text}`);
    }
    const json = (await res.json()) as TokenResponse;
    if (!json.access_token) {
      throw new Error(`Token response for "${accountId}" contained no access_token.`);
    }
    const expiresAt =
      typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : Date.now() + 3_600_000;
    this.logger.debug(`Acquired access token for "${accountId}" (expires in ${json.expires_in ?? '?'}s)`);
    return { accessToken: json.access_token, expiresAt };
  }

  private async discoverTokenEndpoint(issuer: string): Promise<string> {
    if (!issuer) throw new Error('OIDC auth requires an issuer URL.');
    const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const res = await this.fetchFn(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`OIDC discovery failed for ${issuer} (${res.status}).`);
    }
    const doc = (await res.json()) as { token_endpoint?: string };
    if (!doc.token_endpoint) {
      throw new Error(`OIDC discovery for ${issuer} returned no token_endpoint.`);
    }
    return doc.token_endpoint;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '<no body>';
  }
}
