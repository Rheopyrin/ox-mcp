import { describe, expect, it, vi } from 'vitest';
import { CardDavClient, type CardDavBackend } from '../../src/contacts/carddav-client.js';
import { buildVCard } from '../../src/contacts/vcard.js';
import type { ResolvedSection } from '../../src/config/config-resolver.js';
import type { AuthProvider } from '../../src/auth/auth-provider.js';

const section: ResolvedSection = {
  server: 'dav.example.com',
  auth: { type: 'basic', user: 'me@example.com', appPassword: 'pw' },
};

const auth: AuthProvider = {
  getImapAuth: async () => ({ user: 'me@example.com', pass: 'pw' }),
  getSmtpAuth: async () => ({ user: 'me@example.com', pass: 'pw' }),
  getDavAuthHeader: async () => 'Basic xxx',
};

function card(name: string, email: string, org?: string) {
  return { url: `${name}.vcf`, data: buildVCard({ name, emails: [email], organization: org }).vcard };
}

const ALICE = card('Alice Doe', 'alice@example.com', 'ACME');
const BOB = card('Bob Smith', 'bob@example.com');

function makeBackend(overrides: Partial<CardDavBackend> = {}): CardDavBackend {
  return {
    fetchAddressBooks: vi.fn(async () => [
      { url: 'https://dav.example.com/ab/personal/', displayName: 'Personal' },
      { url: 'https://dav.example.com/ab/team/', displayName: 'Team' },
    ]),
    fetchVCards: vi.fn(async ({ addressBook }) =>
      addressBook.url.includes('personal') ? [ALICE] : [BOB],
    ),
    // Server-side query: naive fake that matches FN/EMAIL contains, per book.
    addressBookQuery: vi.fn(async ({ url, filters }) => {
      const cards = url.includes('personal') ? [ALICE] : [BOB];
      const filter = filters as {
        'prop-filter': { 'text-match': { _text: string } }[];
      };
      const needles = filter['prop-filter'].map((p) => p['text-match']._text.toLowerCase());
      return cards
        .filter((c) => needles.some((n) => c.data.toLowerCase().includes(n)))
        .map((c) => ({ href: c.url, props: { addressData: c.data } }));
    }),
    createVCard: vi.fn(async () => ({ ok: true, status: 201 })),
    ...overrides,
  };
}

function makeClient(backend: CardDavBackend) {
  return new CardDavClient(section, auth, async () => backend);
}

describe('CardDavClient — list', () => {
  it('lists address books', async () => {
    const client = makeClient(makeBackend());
    expect(await client.listAddressBooks()).toEqual([
      { url: 'https://dav.example.com/ab/personal/', displayName: 'Personal' },
      { url: 'https://dav.example.com/ab/team/', displayName: 'Team' },
    ]);
  });

  it('lists contacts across all books by default', async () => {
    const client = makeClient(makeBackend());
    const contacts = await client.listContacts();
    expect(contacts.map((c) => c.name).sort()).toEqual(['Alice Doe', 'Bob Smith']);
  });

  it('narrows to one book by display name', async () => {
    const client = makeClient(makeBackend());
    const contacts = await client.listContacts('Team');
    expect(contacts.map((c) => c.name)).toEqual(['Bob Smith']);
  });

  it('throws for an unknown address book', async () => {
    const client = makeClient(makeBackend());
    await expect(client.listContacts('Nope')).rejects.toThrow(/Address book "Nope" not found/);
  });
});

describe('CardDavClient — findContacts (server-side)', () => {
  it('issues an addressbook-query REPORT with contains matchers for the fields', async () => {
    const backend = makeBackend();
    const client = makeClient(backend);
    const results = await client.findContacts('alice');

    expect(results.map((c) => c.name)).toEqual(['Alice Doe']);
    const call = (backend.addressBookQuery as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.props).toHaveProperty(['card:address-data']);
    expect(call.depth).toBe('1');
    const propFilters = call.filters['prop-filter'];
    expect(propFilters.map((p: { _attributes: { name: string } }) => p._attributes.name)).toEqual([
      'FN',
      'EMAIL',
    ]);
    expect(propFilters[0]['text-match']._attributes['match-type']).toBe('contains');
    expect(call.filters._attributes.test).toBe('anyof');
  });

  it('maps custom fields to vCard properties', async () => {
    const backend = makeBackend();
    const client = makeClient(backend);
    await client.findContacts('acme', ['org', 'phone']);
    const call = (backend.addressBookQuery as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(
      call.filters['prop-filter'].map((p: { _attributes: { name: string } }) => p._attributes.name),
    ).toEqual(['ORG', 'TEL']);
  });

  it('handles _cdata-wrapped address data', async () => {
    const backend = makeBackend({
      addressBookQuery: vi.fn(async () => [{ href: 'x.vcf', props: { addressData: { _cdata: ALICE.data } } }]),
    });
    const client = makeClient(backend);
    const results = await client.findContacts('alice', ['name'], 'Personal');
    expect(results[0].name).toBe('Alice Doe');
  });

  it('respects the limit across books', async () => {
    const client = makeClient(makeBackend());
    const results = await client.findContacts('example.com', ['email'], undefined, 1);
    expect(results).toHaveLength(1);
  });
});

describe('CardDavClient — findContacts (fallback)', () => {
  it('falls back to fetch-all + client filter when the REPORT fails', async () => {
    const backend = makeBackend({
      addressBookQuery: vi.fn(async () => {
        throw new Error('REPORT not supported');
      }),
    });
    const client = makeClient(backend);

    expect((await client.findContacts('alice')).map((c) => c.name)).toEqual(['Alice Doe']);
    expect((await client.findContacts('bob@')).map((c) => c.name)).toEqual(['Bob Smith']);
    expect(await client.findContacts('zzz')).toEqual([]);
    expect(backend.fetchVCards).toHaveBeenCalled();
  });

  it('fallback respects the fields argument', async () => {
    const backend = makeBackend({
      addressBookQuery: vi.fn(async () => {
        throw new Error('nope');
      }),
    });
    const client = makeClient(backend);
    // "acme" only appears in ORG — a name/email search must not match it.
    expect(await client.findContacts('acme', ['name', 'email'])).toEqual([]);
    expect((await client.findContacts('acme', ['org'])).map((c) => c.name)).toEqual(['Alice Doe']);
  });
});

describe('CardDavClient — create', () => {
  it('creates a contact in the first book by default', async () => {
    const backend = makeBackend();
    const client = makeClient(backend);
    const res = await client.createContact({ name: 'Carol', emails: ['carol@example.com'] });
    expect(res.uid).toMatch(/@ox-mcp$/);
    expect(backend.createVCard).toHaveBeenCalledWith(
      expect.objectContaining({
        addressBook: expect.objectContaining({ displayName: 'Personal' }),
        filename: `${res.uid}.vcf`,
        vCardString: expect.stringContaining('FN:Carol'),
      }),
    );
  });

  it('surfaces failed creates', async () => {
    const backend = makeBackend({ createVCard: vi.fn(async () => ({ ok: false, status: 403 })) });
    const client = makeClient(backend);
    await expect(client.createContact({ name: 'X' })).rejects.toThrow(/failed \(403\)/);
  });
});
