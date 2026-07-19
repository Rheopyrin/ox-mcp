import { describe, expect, it, vi } from 'vitest';
import { OxHttpMailClient } from '../../src/mail/ox-http-client.js';
import { OxSessionManager, type FetchFn } from '../../src/mail/ox-session.js';
import type { ResolvedMailSection } from '../../src/config/config-resolver.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

const section: ResolvedMailSection = {
  server: 'webmail.example.com',
  transport: 'ox-api',
  auth: { type: 'basic', user: 'me@example.com', appPassword: 'pw' },
  imap: { host: 'webmail.example.com', port: 993, secure: true },
  smtp: { host: 'webmail.example.com', port: 465, secure: true },
};

function jsonResponse(body: unknown, setCookie: string[] = []): Response {
  return {
    ok: true,
    status: 200,
    headers: { getSetCookie: () => setCookie },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Routes fetch calls by URL substring; records every call. */
function makeFetch(routes: [string, () => unknown][]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('login?action=login')) {
      return jsonResponse({ session: 'sess-1' }, ['JSESSIONID=abc; Path=/', 'ox-secret=xyz; HttpOnly']);
    }
    for (const [match, body] of routes) {
      if (url.includes(match)) return jsonResponse({ data: body() });
    }
    return jsonResponse({ error: 'no route', code: 'TEST-404' });
  });
  return { fetchFn: fetchFn as unknown as FetchFn, calls };
}

const ROW = ['143070', 'default0/INBOX', [['Alice', 'alice@example.com']], [[null, 'me@example.com']], null, 'Hello', 1784452728000, 32];

function makeClient(routes: [string, () => unknown][]) {
  const { fetchFn, calls } = makeFetch(routes);
  const sessions = new OxSessionManager(silentLogger, fetchFn);
  const client = new OxHttpMailClient(section, sessions, 'default:mail', fetchFn);
  return { client, calls, sessions };
}

describe('OxSessionManager', () => {
  it('logs in once and caches the session per context', async () => {
    const { fetchFn } = makeFetch([]);
    const sm = new OxSessionManager(silentLogger, fetchFn);
    const s1 = await sm.getSession('webmail.example.com', section.auth, 'default:mail');
    const s2 = await sm.getSession('webmail.example.com', section.auth, 'default:mail');
    expect(s1).toBe(s2);
    expect(s1.session).toBe('sess-1');
    expect(s1.cookies).toBe('JSESSIONID=abc; ox-secret=xyz');
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('rejects non-basic auth with a clear error', async () => {
    const { fetchFn } = makeFetch([]);
    const sm = new OxSessionManager(silentLogger, fetchFn);
    await expect(
      sm.getSession('h', { type: 'xoauth2', user: 'u', accessToken: 't' }, 'default:mail'),
    ).rejects.toThrow(/basic \(app password\) auth only/);
  });

  it('surfaces login failures', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'LGI-0006 invalid credentials' })) as unknown as FetchFn;
    const sm = new OxSessionManager(silentLogger, fetchFn);
    await expect(sm.getSession('h', section.auth, 'ctx')).rejects.toThrow(/LGI-0006/);
  });
});

describe('OxHttpMailClient — mailbox', () => {
  it('lists messages with mapped summaries and OX folder ids', async () => {
    const { client, calls } = makeClient([['mail?action=all', () => [ROW]]]);
    const messages = await client.listMessages('INBOX', 10);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      uid: 143070,
      folder: 'default0/INBOX',
      from: 'Alice <alice@example.com>',
      subject: 'Hello',
      seen: true,
    });
    const url = calls.find((c) => c.url.includes('action=all'))!.url;
    expect(url).toContain('folder=default0%2FINBOX'); // INBOX mapped to OX id
    expect(url).toContain('session=sess-1');
  });

  it('reads a message with body, addresses, and Message-ID', async () => {
    const { client } = makeClient([
      ['mail?action=get', () => ({
        id: '7',
        folder_id: 'default0/INBOX',
        from: [['Alice', 'alice@example.com']],
        to: [[null, 'me@example.com']],
        subject: 'Q',
        received_date: 1784452728000,
        flags: 32,
        headers: { 'Message-ID': '<m1@example.com>' },
        attachments: [
          { content_type: 'text/plain', content: 'body text' },
          { content_type: 'text/html', content: '<p>body</p>' },
        ],
      })],
    ]);
    const msg = await client.readMessage('INBOX', 7);
    expect(msg).toMatchObject({
      uid: 7,
      text: 'body text',
      html: '<p>body</p>',
      messageId: '<m1@example.com>',
      fromAddresses: ['alice@example.com'],
      toAddresses: ['me@example.com'],
    });
  });

  it('search filters client-side across folders and honors criteria', async () => {
    const rowB = ['9', 'default0/Archive', [['Bob', 'bob@example.com']], [], null, 'Invoice', 1784452000000, 0];
    const { client } = makeClient([
      ['folders?action=allVisible', () => ({ private: [['default0/INBOX', 'INBOX'], ['default0/Archive', 'Archive']] })],
      ['folder=default0%2FINBOX', () => [ROW]],
      ['folder=default0%2FArchive', () => [rowB]],
    ]);
    const all = await client.search(undefined, {});
    expect(all).toHaveLength(2);
    const fromAlice = await client.search(undefined, { from: 'alice' });
    expect(fromAlice.map((m) => m.uid)).toEqual([143070]);
    const unseen = await client.search(undefined, { seen: false });
    expect(unseen.map((m) => m.uid)).toEqual([9]);
    const subject = await client.search(undefined, { subject: 'invoice' });
    expect(subject.map((m) => m.uid)).toEqual([9]);
  });

  it('sets seen and flagged via the OX flag bitmask', async () => {
    const { client, calls } = makeClient([['mail?action=update', () => null]]);
    await client.setFlags('INBOX', 7, { seen: true, flagged: false });
    const updates = calls.filter((c) => c.url.includes('action=update'));
    expect(updates).toHaveLength(2);
    expect(JSON.parse(String(updates[0].init?.body))).toEqual({ flags: 32, value: true });
    expect(JSON.parse(String(updates[1].init?.body))).toEqual({ flags: 8, value: false });
  });

  it('moves, deletes, and archives via folder discovery', async () => {
    const { client, calls } = makeClient([
      ['folders?action=allVisible', () => ({ private: [['default0/INBOX', 'INBOX'], ['default0/Archive', 'Archive']] })],
      ['mail?action=update', () => null],
      ['mail?action=delete', () => null],
    ]);
    await client.moveMessage('INBOX', 7, 'Projects');
    const move = calls.find((c) => c.url.includes('action=update'))!;
    expect(JSON.parse(String(move.init?.body))).toEqual({ folder_id: 'default0/Projects' });

    await client.deleteMessage('INBOX', 7);
    const del = calls.find((c) => c.url.includes('action=delete'))!;
    expect(JSON.parse(String(del.init?.body))).toEqual([{ id: '7', folder: 'default0/INBOX' }]);

    const target = await client.moveToSpecialFolder('INBOX', 7, 'archive');
    expect(target).toBe('default0/Archive');
  });

  it('creates and deletes folders', async () => {
    const { client, calls } = makeClient([['folders?action=new', () => 'default0/Projects/Acme'], ['folders?action=delete', () => []]]);
    await client.createFolder('Projects/Acme');
    const create = calls.find((c) => c.url.includes('action=new'))!;
    expect(create.url).toContain('folder_id=default0%2FProjects');
    expect(JSON.parse(String(create.init?.body))).toEqual({ module: 'mail', title: 'Acme' });

    await client.deleteFolder('Projects/Acme');
    const del = calls.find((c) => c.url.includes('action=delete'))!;
    expect(JSON.parse(String(del.init?.body))).toEqual(['default0/Projects/Acme']);
  });

  it('re-logins once on session expiry and retries the request', async () => {
    let mailCalls = 0;
    const { fetchFn, calls } = makeFetch([
      ['mail?action=all', () => (++mailCalls === 1 ? { error: 'session expired', code: 'SES-0203' } : undefined)],
    ]);
    // First mail call returns SES error; second returns rows. Route fn above returns envelope
    // for error case; craft manually:
    const fetch2 = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('login?action=login')) return jsonResponse({ session: `sess-${calls.length}` }, ['c=1']);
      mailCalls += 1;
      if (mailCalls <= 1) return jsonResponse({ error: 'expired', code: 'SES-0203' });
      return jsonResponse({ data: [ROW] });
    }) as unknown as FetchFn;
    mailCalls = 0;
    const sessions = new OxSessionManager(silentLogger, fetch2);
    const client = new OxHttpMailClient(section, sessions, 'default:mail', fetch2);
    const messages = await client.listMessages('INBOX');
    expect(messages).toHaveLength(1);
    const logins = (fetch2 as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).includes('login?action=login'),
    );
    expect(logins).toHaveLength(2); // initial + re-login after SES error
    void fetchFn;
  });

  it('wraps API errors with their OX code', async () => {
    const { client } = makeClient([['mail?action=all', () => undefined]]);
    // route returns {data: undefined} → fine; force error via unknown route:
    await expect(client.readMessage('INBOX', 1)).rejects.toThrow(/TEST-404|no route/);
  });
});

describe('OxHttpMailClient — send & drafts', () => {
  it('sends by PUTting raw RFC822 without a folder', async () => {
    const { client, calls } = makeClient([['mail?action=new', () => 'default0/Sent/123']]);
    const result = await client.send({ to: 'x@example.com', subject: 'Hi', text: 'Hello' });
    expect(result.accepted).toEqual(['x@example.com']);
    const send = calls.find((c) => c.url.includes('action=new'))!;
    expect(send.url).not.toContain('folder=');
    expect(String(send.init?.body)).toContain('Subject: Hi');
    expect(String(send.init?.body)).toContain('From: me@example.com');
  });

  it('saves drafts by importing raw MIME with the draft flag', async () => {
    const { client, calls } = makeClient([['mail?action=new', () => 'default0/Drafts/5']]);
    const raw = await client.buildRaw({ to: '', subject: 'Draft', text: 'wip' });
    await client.saveDraft(raw, 'Drafts');
    const put = calls.find((c) => c.url.includes('action=new'))!;
    expect(put.url).toContain('folder=default0%2FDrafts');
    expect(put.url).toContain('flags=4');
  });
});
