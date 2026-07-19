import { beforeEach, describe, expect, it } from 'vitest';
import { makeFakes, makeRegistry, type Fakes } from './harness.js';
import type { ToolRegistry } from '../../src/tools/registry.js';

let fakes: Fakes;
let reg: ToolRegistry;

beforeEach(() => {
  fakes = makeFakes();
  reg = makeRegistry(fakes);
});

describe('contact tool dispatch', () => {
  it('contact_list dispatches with the address book', async () => {
    const res = await reg.dispatch('contact_list', { addressBook: 'Contacts' });
    expect(res.isError).toBeFalsy();
    expect(fakes.carddav.listContacts).toHaveBeenCalledWith('Contacts');
  });

  it('contact_find dispatches query, fields, book, and limit', async () => {
    const res = await reg.dispatch('contact_find', {
      query: 'ali',
      fields: ['name', 'org'],
      addressBook: 'Contacts',
      limit: 5,
    });
    expect(res.isError).toBeFalsy();
    expect(fakes.carddav.findContacts).toHaveBeenCalledWith('ali', ['name', 'org'], 'Contacts', 5);
  });

  it('contact_find defaults fields and limit', async () => {
    await reg.dispatch('contact_find', { query: 'bob' });
    expect(fakes.carddav.findContacts).toHaveBeenCalledWith('bob', undefined, undefined, 50);
  });

  it('contact_create passes contact fields through', async () => {
    const res = await reg.dispatch('contact_create', {
      name: 'Alice Doe',
      emails: ['alice@example.com'],
      phones: ['+123'],
      organization: 'ACME',
    });
    expect(res.isError).toBeFalsy();
    expect(fakes.carddav.createContact).toHaveBeenCalledWith(
      { name: 'Alice Doe', emails: ['alice@example.com'], phones: ['+123'], organization: 'ACME' },
      undefined,
    );
  });

  it('contact_create is disabled by default (write flag)', async () => {
    const gated = makeRegistry(fakes, {
      servers: { default: { cardDav: { server: 'dav.example.com', auth: { type: 'basic', user: 'me@example.com', appPassword: 'pw' } } } },
    });
    const res = await gated.dispatch('contact_create', { name: 'X' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/disabled/);
  });
});
