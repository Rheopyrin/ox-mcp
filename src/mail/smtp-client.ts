import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type { ResolvedMailSection } from '../config/config-resolver.js';
import type { AuthProvider, TransportAuth } from '../auth/auth-provider.js';
import { DEFAULT_TIMEOUT_MS } from '../core/http.js';
import { buildMimeMessage } from './mime.js';

export type TransportFactory = (options: SMTPTransport.Options) => Transporter;

export interface OutgoingMessage {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string | string[];
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

/** SMTP sending + MIME composition (the latter feeds IMAP draft saving). */
export class SmtpClient {
  constructor(
    private readonly section: ResolvedMailSection,
    private readonly authProvider: AuthProvider,
    private readonly transportFactory: TransportFactory = (options) =>
      nodemailer.createTransport(options),
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async send(message: OutgoingMessage): Promise<SendResult> {
    const auth = await this.authProvider.getSmtpAuth();
    const transport = this.transportFactory({
      host: this.section.smtp.host,
      port: this.section.smtp.port,
      secure: this.section.smtp.secure,
      auth: toNodemailerAuth(auth),
      // Bound each phase so a stalled SMTP server cannot hang the session.
      connectionTimeout: this.timeoutMs,
      greetingTimeout: this.timeoutMs,
      socketTimeout: this.timeoutMs,
    });
    const info = await transport.sendMail({ from: this.section.auth.user, ...message });
    return {
      messageId: info.messageId,
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
    };
  }

  /** Build a raw RFC822 message (for saving as a draft via IMAP APPEND). */
  async buildRaw(message: OutgoingMessage): Promise<string> {
    return buildMimeMessage(this.section.auth.user, message);
  }
}

function toNodemailerAuth(auth: TransportAuth) {
  if ('pass' in auth) {
    return { user: auth.user, pass: auth.pass };
  }
  return { type: 'OAuth2' as const, user: auth.user, accessToken: auth.accessToken };
}
