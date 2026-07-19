import { inject, injectable } from 'inversify';
import { TYPES } from '../core/types.js';
import type { ResolvedAuth } from '../config/config-resolver.js';
import { BasicAuthProvider } from './basic-provider.js';
import { TokenAuthProvider } from './token-provider.js';
import type { TokenManager } from './token-manager.js';

export type UserPassAuth = { user: string; pass: string };
export type UserTokenAuth = { user: string; accessToken: string };
export type TransportAuth = UserPassAuth | UserTokenAuth;

/**
 * Adapts a section's resolved credentials to each transport. IMAP/SMTP receive
 * either `{user,pass}` (basic) or `{user,accessToken}` (XOAUTH2); CalDAV receives
 * a ready-made `Authorization` header value (`Basic ...` or `Bearer ...`).
 */
export interface AuthProvider {
  getImapAuth(): Promise<TransportAuth>;
  getSmtpAuth(): Promise<TransportAuth>;
  getDavAuthHeader(): Promise<string>;
}

export interface AuthProviderFactory {
  /**
   * @param auth      a section's resolved credentials
   * @param contextId cache/error identifier, `<accountId>:<section>`
   */
  create(auth: ResolvedAuth, contextId: string): AuthProvider;
}

@injectable()
export class DefaultAuthProviderFactory implements AuthProviderFactory {
  constructor(@inject(TYPES.TokenManager) private readonly tokenManager: TokenManager) {}

  create(auth: ResolvedAuth, contextId: string): AuthProvider {
    if (auth.type === 'basic') {
      return new BasicAuthProvider(auth, contextId);
    }
    return new TokenAuthProvider(auth, contextId, this.tokenManager);
  }
}
