import { describe, expect, it, vi } from 'vitest';
import { BasicAuthProvider } from '../../src/auth/basic-provider.js';
import { TokenAuthProvider } from '../../src/auth/token-provider.js';
import { DefaultAuthProviderFactory } from '../../src/auth/auth-provider.js';
import { TokenManager, type FetchFn } from '../../src/auth/token-manager.js';
import type { ResolvedAuth } from '../../src/config/config-resolver.js';

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

const CTX = 'default:mail';

function auth(a: ResolvedAuth): ResolvedAuth {
  return a;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('BasicAuthProvider', () => {
  it('provides user/pass and a Basic DAV header', async () => {
    const p = new BasicAuthProvider(auth({ type: 'basic', user: 'me@ex.com', appPassword: 'pw' }), CTX);
    expect(await p.getImapAuth()).toEqual({ user: 'me@ex.com', pass: 'pw' });
    expect(await p.getSmtpAuth()).toEqual({ user: 'me@ex.com', pass: 'pw' });
    expect(await p.getDavAuthHeader()).toBe(`Basic ${Buffer.from('me@ex.com:pw').toString('base64')}`);
  });

  it('throws when app password missing', async () => {
    const p = new BasicAuthProvider(auth({ type: 'basic', user: 'me@ex.com', appPassword: '' }), CTX);
    await expect(p.getImapAuth()).rejects.toThrow(/no app password/);
  });

  it('throws when email missing', async () => {
    const p = new BasicAuthProvider(auth({ type: 'basic', user: '', appPassword: 'pw' }), CTX);
    await expect(p.getImapAuth()).rejects.toThrow(/missing a login user/);
  });
});

describe('TokenAuthProvider', () => {
  it('provides user/accessToken and a Bearer DAV header', async () => {
    const fakeTm = { getAccessToken: vi.fn(async () => 'tok123') } as unknown as TokenManager;
    const p = new TokenAuthProvider(
      auth({ type: 'xoauth2', user: 'me@ex.com', accessToken: 'tok123' }),
      CTX,
      fakeTm,
    );
    expect(await p.getImapAuth()).toEqual({ user: 'me@ex.com', accessToken: 'tok123' });
    expect(await p.getDavAuthHeader()).toBe('Bearer tok123');
  });
});

describe('DefaultAuthProviderFactory', () => {
  it('selects basic vs token providers by auth type', async () => {
    const tm = new TokenManager(noopLogger);
    const factory = new DefaultAuthProviderFactory(tm);
    const basic = factory.create(auth({ type: 'basic', user: 'me@ex.com', appPassword: 'pw' }), CTX);
    const token = factory.create(auth({ type: 'xoauth2', user: 'me@ex.com', accessToken: 't' }), 'default:calDav');
    expect(await basic.getDavAuthHeader()).toMatch(/^Basic /);
    expect(await token.getDavAuthHeader()).toBe('Bearer t');
  });
});

describe('TokenManager', () => {
  it('returns a static xoauth2 token without fetching', async () => {
    const fetchFn = vi.fn();
    const tm = new TokenManager(noopLogger, fetchFn as unknown as FetchFn);
    const tok = await tm.getAccessToken(auth({ type: 'xoauth2', user: 'u', accessToken: 'static' }), CTX);
    expect(tok).toBe('static');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('performs a refresh_token grant and caches the result', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ access_token: 'a1', expires_in: 3600 }),
    );
    const tm = new TokenManager(noopLogger, fetchFn as unknown as FetchFn);
    const acct = auth({
      type: 'oauth2-refresh',
      user: 'u',
      clientId: 'cid',
      clientSecret: 'sec',
      refreshToken: 'rt',
      tokenUrl: 'https://idp/token',
      scope: 'mail',
    });

    expect(await tm.getAccessToken(acct, CTX)).toBe('a1');
    expect(await tm.getAccessToken(acct, CTX)).toBe('a1'); // cached
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const init = fetchFn.mock.calls[0][1]!;
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt');
    expect(body.get('client_id')).toBe('cid');
    expect(body.get('scope')).toBe('mail');
  });

  it('re-fetches when the cached token has expired', async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => jsonResponse({ access_token: `a${++n}`, expires_in: 0 }));
    const tm = new TokenManager(noopLogger, fetchFn as unknown as FetchFn);
    const acct = auth({
      type: 'oauth2-refresh',
      user: 'u',
      clientId: 'cid',
      refreshToken: 'rt',
      tokenUrl: 'https://idp/token',
    });
    expect(await tm.getAccessToken(acct, CTX)).toBe('a1');
    expect(await tm.getAccessToken(acct, CTX)).toBe('a2'); // expired → refetch
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('performs a password grant', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ access_token: 'pw-tok', expires_in: 100 }),
    );
    const tm = new TokenManager(noopLogger, fetchFn as unknown as FetchFn);
    await tm.getAccessToken(
      auth({
        type: 'oauth2-password',
        user: 'me@ex.com',
        clientId: 'cid',
        password: 'p',
        tokenUrl: 'https://idp/token',
      }),
      CTX,
    );
    const body = new URLSearchParams(fetchFn.mock.calls[0][1]!.body as string);
    expect(body.get('grant_type')).toBe('password');
    expect(body.get('username')).toBe('me@ex.com');
    expect(body.get('password')).toBe('p');
  });

  it('discovers the OIDC token endpoint then grants', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('.well-known')) {
        return jsonResponse({ token_endpoint: 'https://idp/oauth/token' });
      }
      return jsonResponse({ access_token: 'oidc-tok', expires_in: 60 });
    });
    const tm = new TokenManager(noopLogger, fetchFn as unknown as FetchFn);
    const tok = await tm.getAccessToken(
      auth({
        type: 'oidc',
        user: 'me@ex.com',
        issuer: 'https://idp/',
        clientId: 'cid',
        refreshToken: 'rt',
      }),
      CTX,
    );
    expect(tok).toBe('oidc-tok');
    expect(fetchFn.mock.calls[0][0]).toBe('https://idp/.well-known/openid-configuration');
    expect(fetchFn.mock.calls[1][0]).toBe('https://idp/oauth/token');
  });

  it('throws a helpful error on token endpoint failure', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, false, 400));
    const tm = new TokenManager(noopLogger, fetchFn as unknown as FetchFn);
    await expect(
      tm.getAccessToken(
        auth({
          type: 'oauth2-refresh',
          user: 'u',
          clientId: 'c',
          refreshToken: 'rt',
          tokenUrl: 'https://idp/token',
        }),
        CTX,
      ),
    ).rejects.toThrow(/failed \(400\)/);
  });

  it('caches tokens per section context, not per account', async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => jsonResponse({ access_token: `t${++n}`, expires_in: 3600 }));
    const tm = new TokenManager(noopLogger, fetchFn as unknown as FetchFn);
    const a = auth({
      type: 'oauth2-refresh',
      user: 'u',
      clientId: 'cid',
      refreshToken: 'rt',
      tokenUrl: 'https://idp/token',
    });
    expect(await tm.getAccessToken(a, 'default:mail')).toBe('t1');
    expect(await tm.getAccessToken(a, 'default:calDav')).toBe('t2'); // separate cache slot
    expect(await tm.getAccessToken(a, 'default:mail')).toBe('t1'); // still cached
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
