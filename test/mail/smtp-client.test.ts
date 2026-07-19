import { describe, expect, it, vi } from 'vitest';
import { SmtpClient } from '../../src/mail/smtp-client.js';
import type { Transporter } from 'nodemailer';
import type { ResolvedMailSection } from '../../src/config/config-resolver.js';
import type { AuthProvider } from '../../src/auth/auth-provider.js';

const section: ResolvedMailSection = {
  server: 'mail.example.com',
  transport: 'imap',
  auth: { type: 'basic', user: 'me@ex.com', appPassword: 'pw' },
  imap: { host: 'mail.example.com', port: 993, secure: true },
  smtp: { host: 'mail.example.com', port: 465, secure: true },
};

const basicAuth: AuthProvider = {
  getImapAuth: async () => ({ user: 'me@ex.com', pass: 'pw' }),
  getSmtpAuth: async () => ({ user: 'me@ex.com', pass: 'pw' }),
  getDavAuthHeader: async () => 'Basic xxx',
};

const tokenAuth: AuthProvider = {
  ...basicAuth,
  getSmtpAuth: async () => ({ user: 'me@ex.com', accessToken: 'tok' }),
};

describe('SmtpClient', () => {
  it('sends with secure options, basic auth and a from header', async () => {
    const sendMail = vi.fn(async () => ({
      messageId: '<id@ex.com>',
      accepted: ['to@ex.com'],
      rejected: [],
    }));
    const captured: { options?: Record<string, unknown> } = {};
    const client = new SmtpClient(section, basicAuth, (options) => {
      captured.options = options as Record<string, unknown>;
      return { sendMail } as unknown as Transporter;
    });

    const result = await client.send({ to: 'to@ex.com', subject: 'Hi', text: 'Body' });

    expect(captured.options).toMatchObject({
      host: 'mail.example.com',
      port: 465,
      secure: true,
      auth: { user: 'me@ex.com', pass: 'pw' },
    });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'me@ex.com', to: 'to@ex.com', subject: 'Hi' }),
    );
    expect(result.messageId).toBe('<id@ex.com>');
    expect(result.accepted).toEqual(['to@ex.com']);
  });

  it('uses OAuth2 auth when a token is provided', async () => {
    const captured: { options?: Record<string, unknown> } = {};
    const client = new SmtpClient(section, tokenAuth, (options) => {
      captured.options = options as Record<string, unknown>;
      return { sendMail: vi.fn(async () => ({ messageId: 'x', accepted: [], rejected: [] })) } as unknown as Transporter;
    });
    await client.send({ to: 'x@ex.com', subject: 's' });
    expect(captured.options?.auth).toEqual({ type: 'OAuth2', user: 'me@ex.com', accessToken: 'tok' });
  });

  it('builds a raw MIME message for drafts', async () => {
    const client = new SmtpClient(section, basicAuth, () => ({}) as unknown as Transporter);
    const raw = await client.buildRaw({ to: 'to@ex.com', subject: 'Draft subject', text: 'draft body' });
    expect(raw).toContain('Subject: Draft subject');
    expect(raw).toContain('to@ex.com');
    expect(raw).toContain('From: me@ex.com');
  });
});
