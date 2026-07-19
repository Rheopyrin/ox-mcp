import { createDAVClient } from 'tsdav';
import type { ResolvedSection } from '../config/config-resolver.js';
import type { AuthProvider } from '../auth/auth-provider.js';
import { DEFAULT_TIMEOUT_MS, withTimeout } from '../core/http.js';
import { buildVCard, parseVCard, type ContactInput, type ContactSummary } from './vcard.js';

export interface AddressBookInfo {
  url: string;
  displayName: string;
}

interface DavAddressBook {
  url: string;
  displayName?: string | Record<string, unknown>;
}

interface DavVCard {
  url: string;
  etag?: string;
  data?: string;
}

/** Narrow subset of the tsdav client we depend on (keeps tests decoupled). */
export interface CardDavBackend {
  fetchAddressBooks(): Promise<DavAddressBook[]>;
  fetchVCards(params: { addressBook: DavAddressBook }): Promise<DavVCard[]>;
  /** RFC 6352 addressbook-query REPORT (server-side search). */
  addressBookQuery(params: {
    url: string;
    props: Record<string, unknown>;
    filters: Record<string, unknown>;
    depth: string;
  }): Promise<{ href?: string; props?: Record<string, unknown> }[]>;
  createVCard(params: {
    addressBook: DavAddressBook;
    vCardString: string;
    filename: string;
  }): Promise<{ ok: boolean; status: number }>;
}

export type ContactSearchField = 'name' | 'email' | 'phone' | 'org';

const FIELD_TO_VCARD_PROP: Record<ContactSearchField, string> = {
  name: 'FN',
  email: 'EMAIL',
  phone: 'TEL',
  org: 'ORG',
};

export type CardDavBackendFactory = (
  section: ResolvedSection,
  authHeader: string,
) => Promise<CardDavBackend>;

/** Build a tsdav-backed factory whose every request times out after `timeoutMs`. */
export function makeCardDavBackendFactory(timeoutMs: number = DEFAULT_TIMEOUT_MS): CardDavBackendFactory {
  const fetchFn = withTimeout(fetch, timeoutMs);
  return async (section, authHeader) => {
    const client = await createDAVClient({
      serverUrl: `https://${section.server}`,
      credentials: {},
      authMethod: 'Custom',
      authFunction: async () => ({ Authorization: authHeader }),
      defaultAccountType: 'carddav',
      fetch: fetchFn,
    });
    return client as unknown as CardDavBackend;
  };
}

export const defaultCardDavBackendFactory: CardDavBackendFactory = makeCardDavBackendFactory();

export class CardDavClient {
  constructor(
    private readonly section: ResolvedSection,
    private readonly authProvider: AuthProvider,
    private readonly backendFactory: CardDavBackendFactory = defaultCardDavBackendFactory,
  ) {}

  async listAddressBooks(): Promise<AddressBookInfo[]> {
    const backend = await this.backend();
    const books = await backend.fetchAddressBooks();
    return books.map((b) => ({ url: b.url, displayName: normalizeName(b.displayName) ?? b.url }));
  }

  /** List contacts. When `addressBook` is omitted, all books are read. */
  async listContacts(addressBook?: string): Promise<ContactSummary[]> {
    const backend = await this.backend();
    const books = await this.selectBooks(backend, addressBook);
    const contacts: ContactSummary[] = [];
    for (const book of books) {
      contacts.push(...(await this.fetchAll(backend, book)));
    }
    return contacts;
  }

  /**
   * Search contacts by a case-insensitive substring over the given fields.
   * Uses a server-side addressbook-query REPORT (RFC 6352) where supported and
   * transparently falls back to fetch-all + client-side filtering per book.
   */
  async findContacts(
    query: string,
    fields: ContactSearchField[] = ['name', 'email'],
    addressBook?: string,
    limit = 50,
  ): Promise<ContactSummary[]> {
    const backend = await this.backend();
    const books = await this.selectBooks(backend, addressBook);
    const results: ContactSummary[] = [];
    for (const book of books) {
      let contacts: ContactSummary[];
      try {
        contacts = await this.queryBook(backend, book, query, fields);
      } catch {
        // Server rejected or mangled the REPORT — filter locally instead.
        contacts = clientFilter(await this.fetchAll(backend, book), query, fields);
      }
      results.push(...contacts);
      if (results.length >= limit) break;
    }
    return results.slice(0, limit);
  }

  private async fetchAll(backend: CardDavBackend, book: DavAddressBook): Promise<ContactSummary[]> {
    const cards = await backend.fetchVCards({ addressBook: book });
    return cards.filter((c) => c.data).map((c) => parseVCard(c.data as string));
  }

  private async queryBook(
    backend: CardDavBackend,
    book: DavAddressBook,
    query: string,
    fields: ContactSearchField[],
  ): Promise<ContactSummary[]> {
    const responses = await backend.addressBookQuery({
      url: book.url,
      props: { 'd:getetag': {}, 'card:address-data': {} },
      filters: buildQueryFilter(query, fields),
      depth: '1',
    });
    return responses
      .map((res) => extractVCardData(res.props))
      .filter((data): data is string => Boolean(data))
      .map(parseVCard);
  }

  async createContact(input: ContactInput, addressBook?: string): Promise<{ uid: string }> {
    const backend = await this.backend();
    const books = await this.selectBooks(backend, addressBook);
    const book = books[0];
    if (!book) throw new Error('No address book found on this account.');
    const { uid, vcard } = buildVCard(input);
    const res = await backend.createVCard({
      addressBook: book,
      vCardString: vcard,
      filename: `${uid}.vcf`,
    });
    if (!res.ok) throw new Error(`CardDAV create contact failed (${res.status}).`);
    return { uid };
  }

  private async backend(): Promise<CardDavBackend> {
    const header = await this.authProvider.getDavAuthHeader();
    return this.backendFactory(this.section, header);
  }

  private async selectBooks(
    backend: CardDavBackend,
    addressBook?: string,
  ): Promise<DavAddressBook[]> {
    const books = await backend.fetchAddressBooks();
    if (!addressBook) return books;
    const match =
      books.find((b) => b.url === addressBook) ??
      books.find((b) => normalizeName(b.displayName) === addressBook);
    if (!match) {
      throw new Error(
        `Address book "${addressBook}" not found. Available: ${books.map((b) => b.url).join(', ')}`,
      );
    }
    return [match];
  }
}

function normalizeName(name: string | Record<string, unknown> | undefined): string | undefined {
  return typeof name === 'string' ? name : undefined;
}

/** RFC 6352 filter: match `query` against any of the mapped vCard properties. */
function buildQueryFilter(query: string, fields: ContactSearchField[]): Record<string, unknown> {
  return {
    _attributes: { test: 'anyof' },
    'prop-filter': fields.map((field) => ({
      _attributes: { name: FIELD_TO_VCARD_PROP[field] },
      'text-match': {
        _attributes: { collation: 'i;unicode-casemap', 'match-type': 'contains' },
        _text: query,
      },
    })),
  };
}

/** tsdav surfaces address-data either as a plain string or as `{ _cdata }`. */
function extractVCardData(props: Record<string, unknown> | undefined): string | undefined {
  const data = props?.addressData as string | { _cdata?: string } | undefined;
  if (typeof data === 'string') return data;
  return data?._cdata;
}

function clientFilter(
  contacts: ContactSummary[],
  query: string,
  fields: ContactSearchField[],
): ContactSummary[] {
  const q = query.toLowerCase();
  return contacts.filter((c) =>
    fields.some((field) => {
      switch (field) {
        case 'name':
          return c.name.toLowerCase().includes(q);
        case 'email':
          return c.emails.some((e) => e.toLowerCase().includes(q));
        case 'phone':
          return c.phones.some((p) => p.toLowerCase().includes(q));
        case 'org':
          return c.organization?.toLowerCase().includes(q) ?? false;
      }
    }),
  );
}
