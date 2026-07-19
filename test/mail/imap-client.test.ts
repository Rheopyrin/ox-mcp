import { describe, expect, it, vi } from 'vitest';
import { ImapClient } from '../../src/mail/imap-client.js';
import type { ImapFlow } from 'imapflow';
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

const RAW_EMAIL = [
  'From: Alice <alice@ex.com>',
  'To: me@ex.com',
  'Subject: Hi there',
  'Message-ID: <abc@ex.com>',
  'Date: Wed, 01 Jan 2026 10:00:00 +0000',
  '',
  'Hello world body',
].join('\r\n');

function envelope() {
  return {
    subject: 'Hi there',
    date: new Date('2026-01-01T10:00:00Z'),
    from: [{ name: 'Alice', address: 'alice@ex.com' }],
    to: [{ address: 'me@ex.com' }],
  };
}

class FakeImapFlow {
  connect = vi.fn(async () => undefined);
  logout = vi.fn(async () => undefined);
  mailbox: { exists: number } | boolean = false;
  list = vi.fn(async () => [{ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' }]);
  getMailboxLock = vi.fn(async () => {
    this.mailbox = { exists: 2 };
    return { release: vi.fn() };
  });
  messageFlagsAdd = vi.fn(async () => true);
  messageFlagsRemove = vi.fn(async () => true);
  messageMove = vi.fn(async () => ({}));
  messageDelete = vi.fn(async () => true);
  mailboxCreate = vi.fn(async () => ({}));
  mailboxDelete = vi.fn(async () => ({}));
  append = vi.fn(async () => ({}));
  search = vi.fn(async () => [1, 2]);
  fetchOne = vi.fn(async () => ({
    uid: 7,
    source: Buffer.from(RAW_EMAIL),
    envelope: envelope(),
    flags: new Set<string>(['\\Seen']),
  }));
  async *fetch() {
    yield { uid: 1, envelope: envelope(), flags: new Set<string>() };
    yield { uid: 2, envelope: envelope(), flags: new Set<string>(['\\Seen']) };
  }
}

function makeClient(fake: FakeImapFlow) {
  const captured: { options?: unknown } = {};
  const client = new ImapClient(section, basicAuth, (options) => {
    captured.options = options;
    return fake as unknown as ImapFlow;
  });
  return { client, captured };
}

describe('ImapClient', () => {
  it('connects with secure IMAP options and the resolved auth', async () => {
    const fake = new FakeImapFlow();
    const { client, captured } = makeClient(fake);
    await client.listFolders();
    expect(captured.options).toMatchObject({
      host: 'mail.example.com',
      port: 993,
      secure: true,
      auth: { user: 'me@ex.com', pass: 'pw' },
      logger: false,
    });
    expect(fake.connect).toHaveBeenCalled();
    expect(fake.logout).toHaveBeenCalled();
  });

  it('lists folders', async () => {
    const { client } = makeClient(new FakeImapFlow());
    const folders = await client.listFolders();
    expect(folders).toEqual([{ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' }]);
  });

  it('lists messages newest-first', async () => {
    const { client } = makeClient(new FakeImapFlow());
    const msgs = await client.listMessages('INBOX', 25);
    expect(msgs.map((m) => m.uid)).toEqual([2, 1]);
    expect(msgs[0]).toMatchObject({ subject: 'Hi there', from: 'Alice <alice@ex.com>', seen: true });
  });

  it('reads and parses a message body', async () => {
    const { client } = makeClient(new FakeImapFlow());
    const msg = await client.readMessage('INBOX', 7);
    expect(msg?.text?.trim()).toBe('Hello world body');
    expect(msg?.messageId).toBe('<abc@ex.com>');
    expect(msg?.subject).toBe('Hi there');
  });

  it('searches and returns summaries', async () => {
    const fake = new FakeImapFlow();
    const { client } = makeClient(fake);
    const results = await client.search('INBOX', { subject: 'Hi' });
    expect(fake.search).toHaveBeenCalledWith({ subject: 'Hi' }, { uid: true });
    expect(results).toHaveLength(2);
  });

  it('defaults to ALL when no search criteria supplied', async () => {
    const fake = new FakeImapFlow();
    const { client } = makeClient(fake);
    await client.search('INBOX', {});
    expect(fake.search).toHaveBeenCalledWith({ all: true }, { uid: true });
  });

  it('sets and clears flags by uid', async () => {
    const fake = new FakeImapFlow();
    const { client } = makeClient(fake);
    await client.setFlags('INBOX', 7, { seen: true, flagged: false });
    expect(fake.messageFlagsAdd).toHaveBeenCalledWith('7', ['\\Seen'], { uid: true });
    expect(fake.messageFlagsRemove).toHaveBeenCalledWith('7', ['\\Flagged'], { uid: true });
  });

  it('moves and deletes messages by uid', async () => {
    const fake = new FakeImapFlow();
    const { client } = makeClient(fake);
    await client.moveMessage('INBOX', 7, 'Archive');
    await client.deleteMessage('INBOX', 7);
    expect(fake.messageMove).toHaveBeenCalledWith('7', 'Archive', { uid: true });
    expect(fake.messageDelete).toHaveBeenCalledWith('7', { uid: true });
  });

  it('appends drafts with the Draft flag', async () => {
    const fake = new FakeImapFlow();
    const { client } = makeClient(fake);
    await client.saveDraft('raw-mime', 'Drafts');
    expect(fake.append).toHaveBeenCalledWith('Drafts', 'raw-mime', ['\\Draft']);
  });

  it('returns [] for an empty mailbox', async () => {
    const fake = new FakeImapFlow();
    fake.getMailboxLock = vi.fn(async () => {
      fake.mailbox = { exists: 0 };
      return { release: vi.fn() };
    });
    const { client } = makeClient(fake);
    expect(await client.listMessages('INBOX')).toEqual([]);
  });

  it('returns null when a message source is missing', async () => {
    const fake = new FakeImapFlow();
    fake.fetchOne = vi.fn(async () => null as never);
    const { client } = makeClient(fake);
    expect(await client.readMessage('INBOX', 7)).toBeNull();
  });

  it('returns [] when a search matches nothing', async () => {
    const fake = new FakeImapFlow();
    fake.search = vi.fn(async () => []);
    const { client } = makeClient(fake);
    expect(await client.search('INBOX', { subject: 'zzz' })).toEqual([]);
  });

  it('searches every selectable folder when folder is omitted', async () => {
    const fake = new FakeImapFlow();
    fake.list = vi.fn(async () => [
      { path: 'INBOX', name: 'INBOX' },
      { path: 'Archive', name: 'Archive' },
      { path: '[Gmail]', name: '[Gmail]', flags: new Set(['\\Noselect']) },
    ]) as never;
    const { client } = makeClient(fake);
    const results = await client.search(undefined, { subject: 'Hi' }, 10);

    // Two selectable folders searched, Noselect skipped.
    expect(fake.getMailboxLock).toHaveBeenCalledWith('INBOX');
    expect(fake.getMailboxLock).toHaveBeenCalledWith('Archive');
    expect(fake.getMailboxLock).not.toHaveBeenCalledWith('[Gmail]');
    // Each result is tagged with its source folder.
    expect(new Set(results.map((r) => r.folder))).toEqual(new Set(['INBOX', 'Archive']));
  });

  it('all-folder search skips folders that fail to open', async () => {
    const fake = new FakeImapFlow();
    fake.list = vi.fn(async () => [
      { path: 'INBOX', name: 'INBOX' },
      { path: 'Broken', name: 'Broken' },
    ]) as never;
    const originalLock = fake.getMailboxLock.bind(fake);
    fake.getMailboxLock = vi.fn(async (folder: string) => {
      if (folder === 'Broken') throw new Error('cannot open');
      return originalLock();
    }) as never;
    const { client } = makeClient(fake);
    const results = await client.search(undefined, {}, 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.folder === 'INBOX')).toBe(true);
  });

  it('caps and sorts all-folder results by date descending', async () => {
    const fake = new FakeImapFlow();
    fake.list = vi.fn(async () => [
      { path: 'A', name: 'A' },
      { path: 'B', name: 'B' },
    ]) as never;
    const { client } = makeClient(fake);
    const results = await client.search(undefined, {}, 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('moves to the Junk folder via special-use detection', async () => {
    const fake = new FakeImapFlow();
    fake.list = vi.fn(async () => [
      { path: 'INBOX', name: 'INBOX' },
      { path: 'Spam Stuff', name: 'Spam Stuff', specialUse: '\\Junk' },
    ]) as never;
    const { client } = makeClient(fake);
    const target = await client.moveToSpecialFolder('INBOX', 7, 'junk');
    expect(target).toBe('Spam Stuff');
    expect(fake.messageMove).toHaveBeenCalledWith('7', 'Spam Stuff', { uid: true });
  });

  it('falls back to folder-name matching for archive', async () => {
    const fake = new FakeImapFlow();
    fake.list = vi.fn(async () => [
      { path: 'INBOX', name: 'INBOX' },
      { path: 'Archive', name: 'Archive' },
    ]) as never;
    const { client } = makeClient(fake);
    const target = await client.moveToSpecialFolder('INBOX', 7, 'archive');
    expect(target).toBe('Archive');
  });

  it('throws when no junk folder exists', async () => {
    const fake = new FakeImapFlow();
    fake.list = vi.fn(async () => [{ path: 'INBOX', name: 'INBOX' }]) as never;
    const { client } = makeClient(fake);
    await expect(client.moveToSpecialFolder('INBOX', 7, 'junk')).rejects.toThrow(/No junk folder/);
  });

  it('creates and deletes folders', async () => {
    const fake = new FakeImapFlow();
    const { client } = makeClient(fake);
    await client.createFolder('Projects/Acme');
    await client.deleteFolder('Projects/Acme');
    expect(fake.mailboxCreate).toHaveBeenCalledWith('Projects/Acme');
    expect(fake.mailboxDelete).toHaveBeenCalledWith('Projects/Acme');
  });

  it('exposes bare reply addresses when reading a message', async () => {
    const { client } = makeClient(new FakeImapFlow());
    const msg = await client.readMessage('INBOX', 7);
    expect(msg?.fromAddresses).toEqual(['alice@ex.com']);
    expect(msg?.toAddresses).toEqual(['me@ex.com']);
  });
});
