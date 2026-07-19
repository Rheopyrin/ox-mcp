import type { ResolvedAuth } from '../config/config-resolver.js';
import type { AuthProvider, TransportAuth } from './auth-provider.js';
import type { TokenManager } from './token-manager.js';

/**
 * Token-based authentication (XOAUTH2 / OAUTHBEARER for mail, Bearer for DAV).
 * Covers `xoauth2`, `oauth2-refresh`, `oauth2-password`, and `oidc` — the
 * TokenManager hides the differences and handles caching/refresh.
 */
export class TokenAuthProvider implements AuthProvider {
  constructor(
    private readonly auth: ResolvedAuth,
    private readonly contextId: string,
    private readonly tokenManager: TokenManager,
  ) {}

  private user(): string {
    if (!this.auth.user) {
      throw new Error(`Section "${this.contextId}" is missing a login user.`);
    }
    return this.auth.user;
  }

  private async token(): Promise<string> {
    return this.tokenManager.getAccessToken(this.auth, this.contextId);
  }

  async getImapAuth(): Promise<TransportAuth> {
    return { user: this.user(), accessToken: await this.token() };
  }

  async getSmtpAuth(): Promise<TransportAuth> {
    return { user: this.user(), accessToken: await this.token() };
  }

  async getDavAuthHeader(): Promise<string> {
    return `Bearer ${await this.token()}`;
  }
}
