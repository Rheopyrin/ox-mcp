import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { OutgoingMessage } from './smtp-client.js';

/**
 * Compose a raw RFC822 message from an outgoing message with a fixed `From`.
 * Shared by the SMTP backend (draft APPEND) and the ox-api backend (send/draft).
 */
export async function buildMimeMessage(from: string, message: OutgoingMessage): Promise<string> {
  const composer = new MailComposer({ from, ...message });
  const buffer: Buffer = await new Promise((resolve, reject) => {
    composer.compile().build((err, msg) => (err ? reject(err) : resolve(msg)));
  });
  return buffer.toString('utf8');
}
