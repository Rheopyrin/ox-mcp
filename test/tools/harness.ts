import { vi } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { ConfigResolver } from '../../src/config/config-resolver.js';
import { configSchema } from '../../src/config/config.schema.js';
import type { Env } from '../../src/config/env.js';
import type { ImapClientFactory, SieveClientFactory, SmtpClientFactory } from '../../src/mail/mail.module.js';
import type { CalDavClientFactory, FreeBusyClientFactory } from '../../src/calendar/calendar.module.js';
import type { CardDavClientFactory } from '../../src/contacts/contacts.module.js';
import type { ImapClient } from '../../src/mail/imap-client.js';
import type { SmtpClient } from '../../src/mail/smtp-client.js';
import type { SieveClient } from '../../src/mail/sieve-client.js';
import type { CalDavClient } from '../../src/calendar/caldav-client.js';
import type { FreeBusyClient } from '../../src/calendar/freebusy-client.js';
import type { CardDavClient } from '../../src/contacts/carddav-client.js';

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

export const originalMessage = {
  uid: 1,
  subject: 'Question',
  from: 'Alice <alice@example.com>',
  to: 'me@example.com, Bob <bob@example.com>',
  date: null,
  flags: [],
  seen: false,
  messageId: '<orig@example.com>',
  text: 'body',
  fromAddresses: ['alice@example.com'],
  toAddresses: ['me@example.com', 'bob@example.com'],
  ccAddresses: ['carol@example.com'],
};

export function makeFakes() {
  return {
    imap: {
      listFolders: vi.fn(async () => [{ path: 'INBOX', name: 'INBOX' }]),
      listMessages: vi.fn(async () => [{ uid: 1, subject: 's' }]),
      readMessage: vi.fn(async () => originalMessage),
      search: vi.fn(async () => [{ uid: 2 }]),
      setFlags: vi.fn(async () => undefined),
      moveMessage: vi.fn(async () => undefined),
      deleteMessage: vi.fn(async () => undefined),
      moveToSpecialFolder: vi.fn(async () => 'Junk'),
      createFolder: vi.fn(async () => undefined),
      deleteFolder: vi.fn(async () => undefined),
      saveDraft: vi.fn(async () => undefined),
    },
    smtp: {
      send: vi.fn(async () => ({ messageId: '<id>', accepted: ['x@example.com'], rejected: [] })),
      buildRaw: vi.fn(async () => 'raw-mime'),
    },
    sieve: {
      listFilters: vi.fn(async () => [{ id: 'f1', name: 'Spam rule' }]),
      createFilter: vi.fn(async () => ({ id: 'f2', name: 'New rule' })),
      updateFilter: vi.fn(async () => ({ id: 'f1', name: 'Updated rule' })),
    },
    caldav: {
      listCalendars: vi.fn(async () => [{ url: 'u', displayName: 'Personal' }]),
      listEvents: vi.fn(async () => [{ uid: 'e1', summary: 'M' }]),
      createEvent: vi.fn(async () => ({ uid: 'e2', url: 'u/e2.ics' })),
      updateEvent: vi.fn(async () => undefined),
      deleteEvent: vi.fn(async () => undefined),
      respondToEvent: vi.fn(async () => undefined),
    },
    carddav: {
      listAddressBooks: vi.fn(async () => [{ url: 'ab', displayName: 'Contacts' }]),
      listContacts: vi.fn(async () => [{ uid: 'c1', name: 'Alice', emails: [], phones: [] }]),
      findContacts: vi.fn(async () => [{ uid: 'c1', name: 'Alice', emails: [], phones: [] }]),
      createContact: vi.fn(async () => ({ uid: 'c2' })),
    },
    freeBusy: {
      getFreeBusy: vi.fn(async () => [{ attendee: 'a@example.com', status: '2.0', busy: [] }]),
    },
  };
}

export type Fakes = ReturnType<typeof makeFakes>;

const basicAuth = { type: 'basic', user: 'me@example.com', appPassword: 'pw' };

/** Account with all three sections configured. */
export const FULL_ACCOUNT = {
  mail: { server: 'mail.example.com', auth: basicAuth },
  calDav: { server: 'dav.example.com', auth: basicAuth },
  cardDav: { server: 'dav.example.com', auth: basicAuth },
};

/** FULL_ACCOUNT with every section's tools enabled (incl. writes). */
export const FULL_ACCOUNT_ALL_ENABLED = {
  mail: { ...FULL_ACCOUNT.mail, enabled: true },
  calDav: { ...FULL_ACCOUNT.calDav, enabled: true },
  cardDav: { ...FULL_ACCOUNT.cardDav, enabled: true },
};

/** Registry with every feature enabled and all protocol clients faked. */
export function makeRegistry(
  fakes: Fakes,
  configInput: unknown = { servers: { default: FULL_ACCOUNT_ALL_ENABLED } },
  env: Env = {},
): ToolRegistry {
  const resolver = new ConfigResolver(configSchema.parse(configInput), env);
  return new ToolRegistry(
    resolver,
    { forAccount: () => fakes.imap as unknown as ImapClient } as ImapClientFactory,
    { forAccount: () => fakes.smtp as unknown as SmtpClient } as SmtpClientFactory,
    { forAccount: () => fakes.sieve as unknown as SieveClient } as SieveClientFactory,
    { forAccount: () => fakes.caldav as unknown as CalDavClient } as CalDavClientFactory,
    { forAccount: () => fakes.carddav as unknown as CardDavClient } as CardDavClientFactory,
    { forAccount: () => fakes.freeBusy as unknown as FreeBusyClient } as FreeBusyClientFactory,
    silentLogger,
  );
}
