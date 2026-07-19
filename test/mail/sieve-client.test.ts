import { describe, expect, it, vi } from 'vitest';
import {
  SieveClient,
  SIEVE_SCRIPT_NAME,
  buildScript,
  parseRules,
  type FilterRule,
  type SieveSession,
} from '../../src/mail/sieve-client.js';
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
  getImapAuth: async () => ({ user: 'me@ex.com', accessToken: 'tok' }),
};

class FakeSession implements SieveSession {
  scripts = new Map<string, string>();
  active?: string;
  closed = false;

  listScripts = vi.fn(async () =>
    [...this.scripts.keys()].map((name) => ({ name, active: name === this.active })),
  );
  getScript = vi.fn(async (name: string) => this.scripts.get(name));
  putScript = vi.fn(async (name: string, content: string) => {
    this.scripts.set(name, content);
  });
  setActive = vi.fn(async (name: string) => {
    this.active = name;
  });
  close = vi.fn(async () => {
    this.closed = true;
  });
}

function makeClient(session: FakeSession, auth: AuthProvider = basicAuth) {
  const captured: { params?: unknown } = {};
  const client = new SieveClient(section, auth, async (params) => {
    captured.params = params;
    return session;
  });
  return { client, captured };
}

const RULE_INPUT = {
  name: 'File spam',
  conditions: [{ field: 'from' as const, contains: 'spam@bad.com' }],
  action: { type: 'fileinto' as const, folder: 'Junk' },
  stop: true,
};

describe('SieveClient', () => {
  it('connects with basic credentials from the auth provider', async () => {
    const session = new FakeSession();
    const { client, captured } = makeClient(session);
    await client.listFilters();
    expect(captured.params).toEqual({ host: 'mail.example.com', user: 'me@ex.com', pass: 'pw' });
    expect(session.closed).toBe(true);
  });

  it('rejects token-based auth with a clear error', async () => {
    const { client } = makeClient(new FakeSession(), tokenAuth);
    await expect(client.listFilters()).rejects.toThrow(/require basic/);
  });

  it('returns [] when no managed script exists', async () => {
    const { client } = makeClient(new FakeSession());
    expect(await client.listFilters()).toEqual([]);
  });

  it('creates a filter: writes a marker-encoded rule and activates the script', async () => {
    const session = new FakeSession();
    const { client } = makeClient(session);
    const rule = await client.createFilter(RULE_INPUT);

    expect(rule.id).toMatch(/^[a-z0-9-]{8}$/i);
    const script = session.scripts.get(SIEVE_SCRIPT_NAME)!;
    expect(script).toContain('require ["fileinto"];');
    expect(script).toContain(`# ox-mcp:rule:${rule.id}:`);
    expect(script).toContain('header :contains "from" "spam@bad.com"');
    expect(script).toContain('fileinto "Junk";');
    expect(script).toContain('stop;');
    expect(session.active).toBe(SIEVE_SCRIPT_NAME);
  });

  it('round-trips: created rules appear in listFilters', async () => {
    const session = new FakeSession();
    const { client } = makeClient(session);
    const created = await client.createFilter(RULE_INPUT);
    const listed = await client.listFilters();
    expect(listed).toEqual([created]);
  });

  it('updates a filter in place and keeps others', async () => {
    const session = new FakeSession();
    const { client } = makeClient(session);
    const first = await client.createFilter(RULE_INPUT);
    const second = await client.createFilter({
      name: 'Redirect boss',
      conditions: [{ field: 'from', contains: 'boss@ex.com' }],
      action: { type: 'redirect', address: 'me@phone.com' },
    });

    const updated = await client.updateFilter(first.id, {
      ...RULE_INPUT,
      name: 'File spam v2',
      action: { type: 'discard' },
    });
    expect(updated.name).toBe('File spam v2');

    const listed = await client.listFilters();
    expect(listed.map((r) => r.name)).toEqual(['File spam v2', 'Redirect boss']);
    expect(listed.find((r) => r.id === second.id)?.action.type).toBe('redirect');
  });

  it('throws for an unknown filter id', async () => {
    const { client } = makeClient(new FakeSession());
    await expect(client.updateFilter('nope', RULE_INPUT)).rejects.toThrow(/No filter with id/);
  });

  it('validates rule completeness', async () => {
    const { client } = makeClient(new FakeSession());
    await expect(
      client.createFilter({ ...RULE_INPUT, action: { type: 'fileinto' } }),
    ).rejects.toThrow(/requires a target folder/);
    await expect(
      client.createFilter({ ...RULE_INPUT, conditions: [{ field: 'header', contains: 'x' }] }),
    ).rejects.toThrow(/header name/);
    await expect(client.createFilter({ ...RULE_INPUT, conditions: [] })).rejects.toThrow(
      /at least one condition/,
    );
  });
});

describe('buildScript / parseRules', () => {
  const rules: FilterRule[] = [
    {
      id: 'aaaa1111',
      name: 'Multi',
      conditions: [
        { field: 'subject', contains: 'invoice' },
        { field: 'header', header: 'X-Priority', contains: '1' },
      ],
      matchAll: true,
      action: { type: 'markRead' },
    },
  ];

  it('emits allof for matchAll and the imap4flags capability', () => {
    const script = buildScript(rules);
    expect(script).toContain('require ["imap4flags"];');
    expect(script).toContain('allof (header :contains "subject" "invoice", header :contains "X-Priority" "1")');
    expect(script).toContain('addflag "\\\\Seen";');
  });

  it('parseRules recovers exactly what buildScript wrote', () => {
    expect(parseRules(buildScript(rules))).toEqual(rules);
  });

  it('escapes quotes and backslashes in sieve strings', () => {
    const script = buildScript([
      {
        id: 'bbbb2222',
        name: 'Escapes',
        conditions: [{ field: 'subject', contains: 'say "hi" \\ bye' }],
        action: { type: 'discard' },
      },
    ]);
    expect(script).toContain('"say \\"hi\\" \\\\ bye"');
  });

  it('ignores corrupted markers', () => {
    expect(parseRules('# ox-mcp:rule:xyz:!!!notbase64!!!\r\n')).toEqual([]);
  });
});
