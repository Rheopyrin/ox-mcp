import { describe, expect, it, vi } from 'vitest';
import { OxFilterClient, fromOxRule, toOxRule } from '../../src/mail/ox-filter-client.js';
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

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { getSetCookie: () => ['JSESSIONID=a'] },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeClient(routes: [string, (init?: RequestInit) => unknown][]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('login?action=login')) return jsonResponse({ session: 's1' });
    for (const [match, body] of routes) {
      if (url.includes(match)) return jsonResponse({ data: body(init) });
    }
    return jsonResponse({ error: 'no route', code: 'TEST-404' });
  }) as unknown as FetchFn;
  const client = new OxFilterClient(section, new OxSessionManager(silentLogger, fetchFn), 'default:mail', fetchFn);
  return { client, calls };
}

// A realistic OX rule (captured shape from a live 7.10.6 server).
const OX_RULE = {
  id: 16,
  position: 1,
  rulename: 'Git',
  active: true,
  flags: [],
  test: { id: 'from', comparison: 'contains', values: ['git@example.com'] },
  actioncmds: [{ id: 'move', into: 'default0/INBOX/Git' }, { id: 'stop' }],
};

describe('OxFilterClient', () => {
  it('lists rules mapped to the shared filter model', async () => {
    const { client } = makeClient([['mailfilter/v2?action=list', () => [OX_RULE]]]);
    const rules = await client.listFilters();
    expect(rules).toEqual([
      {
        id: '16',
        name: 'Git',
        active: true,
        conditions: [{ field: 'from', contains: 'git@example.com' }],
        matchAll: undefined,
        action: { type: 'fileinto', folder: 'default0/INBOX/Git' },
        stop: true,
      },
    ]);
  });

  it('creates a rule and returns the server-assigned id', async () => {
    const { client, calls } = makeClient([['mailfilter/v2?action=new', () => 42]]);
    const rule = await client.createFilter({
      name: 'Spam rule',
      conditions: [{ field: 'subject', contains: 'lottery' }],
      action: { type: 'discard' },
      stop: true,
    });
    expect(rule.id).toBe('42');
    const body = JSON.parse(String(calls.find((c) => c.url.includes('action=new'))!.init?.body));
    expect(body).toEqual({
      rulename: 'Spam rule',
      active: true,
      flags: [],
      test: { id: 'header', comparison: 'contains', headers: ['Subject'], values: ['lottery'] },
      actioncmds: [{ id: 'discard' }, { id: 'stop' }],
    });
  });

  it('updates a rule by numeric id', async () => {
    const { client, calls } = makeClient([['mailfilter/v2?action=update', () => null]]);
    await client.updateFilter('16', {
      name: 'Git v2',
      conditions: [{ field: 'from', contains: 'git@example.com' }],
      action: { type: 'fileinto', folder: 'INBOX/Git' },
    });
    const body = JSON.parse(String(calls.find((c) => c.url.includes('action=update'))!.init?.body));
    expect(body.id).toBe(16);
    expect(body.rulename).toBe('Git v2');
    expect(body.actioncmds).toEqual([{ id: 'move', into: 'default0/INBOX/Git' }]);
  });
});

describe('toOxRule / fromOxRule mapping', () => {
  it('multi-condition AND maps to allof with header tests', () => {
    const ox = toOxRule({
      name: 'Multi',
      conditions: [
        { field: 'from', contains: 'boss@' },
        { field: 'header', header: 'X-Priority', contains: '1' },
      ],
      matchAll: true,
      action: { type: 'markRead' },
    });
    expect(ox.test).toEqual({
      id: 'allof',
      tests: [
        { id: 'header', comparison: 'contains', headers: ['From'], values: ['boss@'] },
        { id: 'header', comparison: 'contains', headers: ['X-Priority'], values: ['1'] },
      ],
    });
    expect(ox.actioncmds).toEqual([{ id: 'addflags', flags: ['\\seen'] }]);
  });

  it('redirect maps both ways', () => {
    const ox = toOxRule({
      name: 'fwd',
      conditions: [{ field: 'to', contains: 'sales@' }],
      action: { type: 'redirect', address: 'me@phone.com' },
    });
    expect(ox.actioncmds).toEqual([{ id: 'redirect', to: 'me@phone.com' }]);
    const back = fromOxRule({ id: 1, rulename: 'fwd', test: ox.test, actioncmds: ox.actioncmds });
    expect(back.action).toEqual({ type: 'redirect', address: 'me@phone.com' });
    expect(back.conditions).toEqual([{ field: 'to', contains: 'sales@' }]);
  });

  it('header test names map back to known fields case-insensitively', () => {
    const back = fromOxRule({
      id: 2,
      rulename: 'h',
      test: { id: 'header', comparison: 'contains', headers: ['subject'], values: ['x'] },
      actioncmds: [{ id: 'discard' }],
    });
    expect(back.conditions).toEqual([{ field: 'subject', contains: 'x' }]);
  });

  it('surfaces inexpressible tests and actions instead of dropping them', () => {
    const back = fromOxRule({
      id: 3,
      rulename: 'vacation-ish',
      test: { id: 'size', comparison: 'over', values: ['1M'] },
      actioncmds: [{ id: 'vacation' }],
    });
    expect(back.conditions).toEqual([{ field: 'header', header: '(ox:size)', contains: '1M' }]);
    expect(back.action).toEqual({ type: 'other', description: 'vacation' });
  });

  it('refuses to write back an "other" action', () => {
    expect(() =>
      toOxRule({ name: 'x', conditions: [{ field: 'from', contains: 'a' }], action: { type: 'other' } }),
    ).toThrow(/read-only/);
  });
});
