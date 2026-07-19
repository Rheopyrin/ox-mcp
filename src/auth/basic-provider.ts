import type { ResolvedAuth } from '../config/config-resolver.js';
import type { AuthProvider, TransportAuth } from './auth-provider.js';

/** Username + app-password authentication (SASL LOGIN / HTTP Basic). */
export class BasicAuthProvider implements AuthProvider {
  constructor(
    private readonly auth: ResolvedAuth,
    private readonly contextId: string,
  ) {}

  private creds(): { user: string; pass: string } {
    const auth = this.auth;
    if (auth.type !== 'basic') {
      throw new Error(`BasicAuthProvider used for auth type "${auth.type}"`);
    }
    if (!auth.user) {
      throw new Error(`Section "${this.contextId}" is missing a login user.`);
    }
    if (!auth.appPassword) {
      throw new Error(
        `Section "${this.contextId}" has no app password. Set it in config.json or OX_MCP_* env vars.`,
      );
    }
    return { user: auth.user, pass: auth.appPassword };
  }

  async getImapAuth(): Promise<TransportAuth> {
    return this.creds();
  }

  async getSmtpAuth(): Promise<TransportAuth> {
    return this.creds();
  }

  async getDavAuthHeader(): Promise<string> {
    const { user, pass } = this.creds();
    return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }
}
