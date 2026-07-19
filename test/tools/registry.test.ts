import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/config/env.js';
import { FULL_ACCOUNT, makeFakes, makeRegistry } from './harness.js';

function registry(configInput?: unknown, env: Env = {}, fakes = makeFakes()) {
  return {
    reg: makeRegistry(
      fakes,
      configInput ?? { servers: { default: FULL_ACCOUNT } },
      env,
    ),
    fakes,
  };
}

describe('ToolRegistry visibility', () => {
  it('default flags show reads + list_servers, hide writes', () => {
    const names = registry().reg.visibleTools().map((t) => t.name);
    expect(names).toContain('list_servers');
    expect(names).toContain('email_search');
    expect(names).toContain('email_filter_list');
    expect(names).toContain('calendar_free_busy');
    expect(names).toContain('contact_list');
    expect(names).not.toContain('email_send');
    expect(names).not.toContain('email_reply');
    expect(names).not.toContain('email_mark_spam');
    expect(names).not.toContain('email_filter_create');
    expect(names).not.toContain('email_create_folder');
    expect(names).not.toContain('calendar_delete_event');
    expect(names).not.toContain('calendar_accept_event');
    expect(names).not.toContain('contact_create');
  });

  it('shows a write when enabled globally', () => {
    const names = registry({ servers: { default: { mail: { server: 'mail.example.com', auth: { type: 'basic', user: 'me@example.com', appPassword: 'pw' }, features: { send: true } } } } })
      .reg.visibleTools()
      .map((t) => t.name);
    expect(names).toContain('email_send');
  });

  it('shows a write when enabled for at least one account', () => {
    const names = registry({
      servers: { a: FULL_ACCOUNT, b: { mail: { server: 'mail.b.com', auth: { type: 'basic', user: 'me@example.com', appPassword: 'pw' }, features: { send: true } } } },
    })
      .reg.visibleTools()
      .map((t) => t.name);
    expect(names).toContain('email_send');
  });

  it('hides a read when disabled everywhere', () => {
    const names = registry({ servers: { default: { mail: { server: 'mail.example.com', auth: { type: 'basic', user: 'me@example.com', appPassword: 'pw' }, features: { search: false } } } } })
      .reg.visibleTools()
      .map((t) => t.name);
    expect(names).not.toContain('email_search');
  });

  it('a disabled group hides all its tools', () => {
    const names = registry({ servers: { default: { ...FULL_ACCOUNT, calDav: { ...FULL_ACCOUNT.calDav, enabled: false } } } })
      .reg.visibleTools()
      .map((t) => t.name);
    expect(names).not.toContain('calendar_list');
    expect(names).not.toContain('calendar_list_events');
    expect(names).not.toContain('calendar_free_busy');
    expect(names).toContain('email_search'); // other groups unaffected
    expect(names).toContain('contact_list');
  });

  it('the shared respondEvent feature reveals all three RSVP tools at once', () => {
    const names = registry({
      servers: { default: { calDav: { server: 'dav.example.com', auth: { type: 'basic', user: 'me@example.com', appPassword: 'pw' }, features: { respondEvent: true } } } },
    })
      .reg.visibleTools()
      .map((t) => t.name);
    expect(names).toContain('calendar_accept_event');
    expect(names).toContain('calendar_decline_event');
    expect(names).toContain('calendar_tentative_event');
  });
});

describe('ToolRegistry dispatch', () => {
  it('runs list_servers without secrets', async () => {
    const res = await registry().reg.dispatch('list_servers', {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).not.toContain('appPassword');
    expect(res.content[0].text).toContain('"id": "default"');
  });

  it('runs an enabled read tool', async () => {
    const { reg, fakes } = registry();
    const res = await reg.dispatch('email_list_folders', {});
    expect(res.content[0].text).toContain('INBOX');
    expect(fakes.imap.listFolders).toHaveBeenCalled();
  });

  it('rejects a disabled write tool', async () => {
    const res = await registry().reg.dispatch('email_send', { to: 'x@example.com', subject: 's' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/disabled for server "default"/);
  });

  it('enforces per-account flags', async () => {
    const { reg, fakes } = registry({
      servers: { default: FULL_ACCOUNT, work: { mail: { server: 'mail.work.com', auth: { type: 'basic', user: 'me@example.com', appPassword: 'pw' }, features: { send: true } } } },
    });
    const denied = await reg.dispatch('email_send', { server: 'default', to: 'x@example.com', subject: 's' });
    expect(denied.isError).toBe(true);
    const ok = await reg.dispatch('email_send', { server: 'work', to: 'x@example.com', subject: 's' });
    expect(ok.isError).toBeFalsy();
    expect(fakes.smtp.send).toHaveBeenCalled();
  });

  it('returns an error result for unknown tools', async () => {
    const res = await registry().reg.dispatch('nope', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Unknown tool/);
  });

  it('traps tool execution errors', async () => {
    const fakes = makeFakes();
    fakes.imap.listFolders = vi.fn(async () => {
      throw new Error('IMAP down');
    });
    const res = await registry(undefined, {}, fakes).reg.dispatch('email_list_folders', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/IMAP down/);
  });

  it('surfaces unknown-server errors from execution', async () => {
    const res = await registry().reg.dispatch('email_list_folders', { server: 'ghost' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Unknown server "ghost"/);
  });
});
