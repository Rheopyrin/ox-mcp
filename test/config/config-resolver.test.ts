import { describe, expect, it } from 'vitest';
import { ConfigResolver, requireSection } from '../../src/config/config-resolver.js';
import { configSchema, type RawConfig } from '../../src/config/config.schema.js';
import type { Env } from '../../src/config/env.js';

function cfg(input: unknown = {}): RawConfig {
  return configSchema.parse(input);
}

function resolver(configInput: unknown = {}, env: Env = {}): ConfigResolver {
  return new ConfigResolver(cfg(configInput), env);
}

const basic = (user: string) => ({ type: 'basic', user, appPassword: 'pw' });

const FULL = {
  servers: {
    default: {
      mail: { server: 'mail.example.com', auth: basic('me@example.com') },
      calDav: { server: 'dav.example.com', auth: basic('me@example.com') },
      cardDav: { server: 'dav.example.com', auth: basic('me@example.com') },
    },
  },
};

describe('ConfigResolver — sections', () => {
  it('resolves per-section servers and auth', () => {
    const acct = resolver(FULL).getServer();
    expect(acct.mail?.server).toBe('mail.example.com');
    expect(acct.calDav?.server).toBe('dav.example.com');
    expect(acct.mail?.auth).toMatchObject({ type: 'basic', user: 'me@example.com' });
  });

  it('absent sections resolve to undefined', () => {
    const acct = resolver({
      servers: { default: { calDav: { server: 'dav.example.com', auth: basic('u@example.com') } } },
    }).getServer();
    expect(acct.mail).toBeUndefined();
    expect(acct.cardDav).toBeUndefined();
    expect(acct.calDav).toBeDefined();
  });

  it('sections can hold DIFFERENT credentials (scoped app passwords)', () => {
    const acct = resolver({
      servers: {
        default: {
          mail: { server: 'mail.example.com', auth: { type: 'basic', user: 'me@example.com', appPassword: 'mail-pw' } },
          calDav: { server: 'dav.example.com', auth: { type: 'basic', user: 'me@example.com', appPassword: 'caldav-pw' } },
        },
      },
    }).getServer();
    expect(acct.mail?.auth).toMatchObject({ appPassword: 'mail-pw' });
    expect(acct.calDav?.auth).toMatchObject({ appPassword: 'caldav-pw' });
  });

  it('mail endpoints default to server with TLS ports', () => {
    const mail = resolver(FULL).getServer().mail!;
    expect(mail.imap).toEqual({ host: 'mail.example.com', port: 993, secure: true });
    expect(mail.smtp).toEqual({ host: 'mail.example.com', port: 465, secure: true });
  });

  it('mail endpoints support split hosts and STARTTLS ports (config)', () => {
    const acct = resolver({
      servers: {
        default: {
          mail: {
            server: '',
            imap: { host: 'imap.gmail.com', port: 993 },
            smtp: { host: 'smtp.gmail.com', port: 587 },
            auth: basic('me@gmail.com'),
          },
        },
      },
    }).getServer();
    expect(acct.mail?.imap).toEqual({ host: 'imap.gmail.com', port: 993, secure: true });
    expect(acct.mail?.smtp).toEqual({ host: 'smtp.gmail.com', port: 587, secure: false });
  });

  it('honors an explicit secure override on a non-standard port (config)', () => {
    const acct = resolver({
      servers: {
        default: {
          mail: {
            server: 'mail.example.com',
            imap: { port: 1993, secure: true }, // TLS on a non-standard port
            smtp: { port: 2525, secure: false },
            auth: basic('u@example.com'),
          },
        },
      },
    }).getServer();
    expect(acct.mail?.imap).toEqual({ host: 'mail.example.com', port: 1993, secure: true });
    expect(acct.mail?.smtp).toEqual({ host: 'mail.example.com', port: 2525, secure: false });
  });

  it('secure env override beats config and port heuristic', () => {
    const acct = resolver(
      { servers: { default: { mail: { server: 'mail.example.com', imap: { secure: true }, auth: basic('u@example.com') } } } },
      { OX_MCP_MAIL_IMAP_SECURE: 'false', OX_MCP_MAIL_SMTP_SECURE: 'true' },
    ).getServer();
    expect(acct.mail?.imap.secure).toBe(false); // env false beats config true
    expect(acct.mail?.smtp.secure).toBe(true); // env true beats port-465 default (also true)
  });

  it('mail endpoint env overrides beat config and server fallback', () => {
    const acct = resolver(
      { servers: { default: { mail: { server: 'mail.example.com', smtp: { port: 587 }, auth: basic('u@example.com') } } } },
      { OX_MCP_MAIL_SMTP_HOST: 'out.example.com', OX_MCP_MAIL_IMAP_PORT: '143' },
    ).getServer();
    expect(acct.mail?.smtp).toEqual({ host: 'out.example.com', port: 587, secure: false });
    expect(acct.mail?.imap).toEqual({ host: 'mail.example.com', port: 143, secure: false });
  });

  it('env alone can define a section (single-account convenience)', () => {
    const acct = resolver(
      {},
      {
        OX_MCP_CALDAV_SERVER: 'dav.example.com',
        OX_MCP_CALDAV_USER: 'me@example.com',
        OX_MCP_CALDAV_APP_PASSWORD: 'secret',
      },
    ).getServer();
    expect(acct.calDav).toMatchObject({
      server: 'dav.example.com',
      auth: { type: 'basic', user: 'me@example.com', appPassword: 'secret' },
    });
    expect(acct.mail).toBeUndefined();
  });

  it('indexed env vars define multiple accounts', () => {
    const r = resolver(
      {},
      {
        OX_MCP_ACCOUNTS: 'work,personal',
        OX_MCP_WORK_MAIL_SERVER: 'mail.work.com',
        OX_MCP_WORK_MAIL_USER: 'w@work.com',
        OX_MCP_PERSONAL_CALDAV_SERVER: 'dav.personal.com',
        OX_MCP_PERSONAL_CALDAV_USER: 'p@personal.com',
        OX_MCP_DEFAULT_SERVER: 'work',
      },
    );
    expect(new Set(r.serverIds())).toEqual(new Set(['work', 'personal']));
    expect(r.defaultServerId).toBe('work');
    expect(r.getServer('work').mail?.auth.user).toBe('w@work.com');
    expect(r.getServer('personal').calDav?.server).toBe('dav.personal.com');
  });

  it('per-section env overrides per-section config field-by-field', () => {
    const acct = resolver(
      { servers: { work: { mail: { server: 'cfg.host', auth: basic('old@example.com') } } } },
      { OX_MCP_WORK_MAIL_USER: 'new@example.com' },
    ).getServer('work');
    expect(acct.mail?.auth.user).toBe('new@example.com'); // env wins
    expect(acct.mail?.server).toBe('cfg.host'); // config where env absent
  });

  it('throws on unknown server id', () => {
    expect(() => resolver(FULL).getServer('nope')).toThrow(/Unknown server "nope"/);
  });

  it('requireSection throws an actionable error for a missing section', () => {
    const acct = resolver({
      servers: { default: { calDav: { server: 'dav.example.com', auth: basic('u@example.com') } } },
    }).getServer();
    expect(() => requireSection(acct, 'mail')).toThrow(/no mail section configured/);
    expect(requireSection(acct, 'calDav').server).toBe('dav.example.com');
  });
});

describe('ConfigResolver — request timeout', () => {
  it('defaults to 300 seconds when unset', () => {
    expect(resolver(FULL).timeoutMs).toBe(300_000);
  });

  it('reads timeoutSeconds from config', () => {
    expect(resolver({ ...FULL, timeoutSeconds: 45 }).timeoutMs).toBe(45_000);
  });

  it('lets the env override beat config', () => {
    expect(
      resolver({ ...FULL, timeoutSeconds: 45 }, { OX_MCP_TIMEOUT_SECONDS: '10' }).timeoutMs,
    ).toBe(10_000);
  });

  it('ignores a non-positive or non-numeric env value', () => {
    expect(resolver(FULL, { OX_MCP_TIMEOUT_SECONDS: '0' }).timeoutMs).toBe(300_000);
    expect(resolver(FULL, { OX_MCP_TIMEOUT_SECONDS: 'abc' }).timeoutMs).toBe(300_000);
  });
});

describe('ConfigResolver — per-section auth types', () => {
  it('resolves oauth2-refresh from env over config for one section only', () => {
    const r = resolver(
      { servers: { work: { mail: { server: 'mail.example.com', auth: basic('w@example.com') }, calDav: { server: 'dav.example.com', auth: basic('w@example.com') } } } },
      {
        OX_MCP_WORK_CALDAV_AUTH_TYPE: 'oauth2-refresh',
        OX_MCP_WORK_CALDAV_CLIENT_ID: 'cid',
        OX_MCP_WORK_CALDAV_REFRESH_TOKEN: 'rt',
        OX_MCP_WORK_CALDAV_TOKEN_URL: 'https://token',
      },
    );
    const acct = r.getServer('work');
    expect(acct.calDav?.auth).toMatchObject({
      type: 'oauth2-refresh',
      user: 'w@example.com', // user carried from config despite type switch
      clientId: 'cid',
      refreshToken: 'rt',
      tokenUrl: 'https://token',
    });
    expect(acct.mail?.auth.type).toBe('basic'); // untouched section
  });

  it('reads oidc fields from config when type matches', () => {
    const acct = resolver({
      servers: {
        default: {
          calDav: {
            server: 'dav.example.com',
            auth: { type: 'oidc', user: 'me@example.com', issuer: 'https://idp', clientId: 'cid' },
          },
        },
      },
    }).getServer();
    expect(acct.calDav?.auth).toMatchObject({ type: 'oidc', issuer: 'https://idp', clientId: 'cid' });
  });
});

describe('ConfigResolver — feature flags (per-section)', () => {
  it('defaults: reads enabled, writes disabled (for present sections)', () => {
    const r = resolver(FULL);
    expect(r.isToolEnabled('email_search', 'default')).toBe(true);
    expect(r.isToolEnabled('email_send', 'default')).toBe(false);
    expect(r.isToolEnabled('calendar_list', 'default')).toBe(true);
    expect(r.isToolEnabled('calendar_accept_event', 'default')).toBe(false);
    expect(r.isToolEnabled('contact_list', 'default')).toBe(true);
    expect(r.isToolEnabled('contact_create', 'default')).toBe(false);
  });

  it('absent section disables its tools regardless of env flags', () => {
    const r = resolver(
      { servers: { default: { calDav: { server: 'dav.example.com', auth: basic('u@example.com') } } } },
      { OX_MCP_ENABLE_EMAIL_SEND: 'true' },
    );
    expect(r.isToolEnabled('email_send', 'default')).toBe(false);
    expect(r.isToolEnabled('email_search', 'default')).toBe(false);
    expect(r.isToolEnabledForAny('email_search')).toBe(false);
    expect(r.isToolEnabled('calendar_list', 'default')).toBe(true);
  });

  it('ungated tools are always enabled', () => {
    const r = resolver(FULL);
    expect(r.isToolEnabled('list_servers', 'default')).toBe(true);
    expect(r.isToolEnabledForAny('list_servers')).toBe(true);
  });

  it('section.features tool flags work', () => {
    const r = resolver({
      servers: {
        default: {
          mail: { server: 'mail.example.com', auth: basic('u@example.com'), features: { send: true } },
        },
      },
    });
    expect(r.isToolEnabled('email_send', 'default')).toBe(true);
    expect(r.isToolEnabled('email_delete', 'default')).toBe(false);
  });

  it('section.enabled=false is a config group master switch', () => {
    const r = resolver({
      servers: {
        default: {
          mail: { server: 'mail.example.com', auth: basic('u@example.com'), enabled: false },
          calDav: { server: 'dav.example.com', auth: basic('u@example.com') },
        },
      },
    });
    expect(r.isToolEnabled('email_search', 'default')).toBe(false);
    expect(r.isToolEnabled('calendar_list', 'default')).toBe(true);
  });

  it('tool flag beats section.enabled', () => {
    const r = resolver({
      servers: {
        default: {
          mail: { server: 'mail.example.com', auth: basic('u@example.com'), enabled: false, features: { search: true } },
        },
      },
    });
    expect(r.isToolEnabled('email_search', 'default')).toBe(true);
    expect(r.isToolEnabled('email_list', 'default')).toBe(false);
  });

  it('one feature gates all three RSVP tools', () => {
    const r = resolver({
      servers: {
        default: {
          calDav: { server: 'dav.example.com', auth: basic('u@example.com'), features: { respondEvent: true } },
        },
      },
    });
    expect(r.isToolEnabled('calendar_accept_event', 'default')).toBe(true);
    expect(r.isToolEnabled('calendar_decline_event', 'default')).toBe(true);
    expect(r.isToolEnabled('calendar_tentative_event', 'default')).toBe(true);
  });

  it('precedence: env ALWAYS beats config — acct env tool > acct env group > global env tool > global env group > config tool > config enabled', () => {
    const base = {
      servers: {
        work: { mail: { server: 'mail.example.com', auth: basic('u@example.com'), enabled: false, features: { send: true } } },
      },
    };
    // config tool (true) beats config enabled (false)
    expect(resolver(base).isToolEnabled('email_send', 'work')).toBe(true);
    // GLOBAL env tool beats config tool (env-first rule)
    expect(
      resolver(base, { OX_MCP_ENABLE_EMAIL_SEND: 'false' }).isToolEnabled('email_send', 'work'),
    ).toBe(false);
    // global env group beats config too
    expect(
      resolver(base, { OX_MCP_ENABLE_MAIL: 'false' }).isToolEnabled('email_send', 'work'),
    ).toBe(false);
    // global env tool beats global env group
    expect(
      resolver(base, { OX_MCP_ENABLE_MAIL: 'false', OX_MCP_ENABLE_EMAIL_SEND: 'true' }).isToolEnabled('email_send', 'work'),
    ).toBe(true);
    // acct env group beats global env tool
    expect(
      resolver(base, { OX_MCP_ENABLE_EMAIL_SEND: 'true', OX_MCP_WORK_ENABLE_MAIL: 'false' }).isToolEnabled('email_send', 'work'),
    ).toBe(false);
    // acct env tool beats everything
    expect(
      resolver(base, {
        OX_MCP_ENABLE_EMAIL_SEND: 'false',
        OX_MCP_WORK_ENABLE_MAIL: 'false',
        OX_MCP_WORK_ENABLE_EMAIL_SEND: 'true',
      }).isToolEnabled('email_send', 'work'),
    ).toBe(true);
  });

  it('default-account per-account flag uses the DEFAULT_ segment', () => {
    const r = resolver(FULL, { OX_MCP_DEFAULT_ENABLE_EMAIL_SEND: 'true' });
    expect(r.isToolEnabled('email_send', 'default')).toBe(true);
  });
});

describe('ConfigResolver — strict validation', () => {
  it('passes when every present section has server + user', () => {
    expect(() => resolver(FULL).validate()).not.toThrow();
  });

  it('mail-only and dav-only accounts are valid', () => {
    expect(() =>
      resolver({ servers: { a: { mail: { server: 'mail.example.com', auth: basic('u@example.com') } } } }).validate(),
    ).not.toThrow();
    expect(() =>
      resolver({ servers: { b: { calDav: { server: 'dav.example.com', auth: basic('u@example.com') } } } }).validate(),
    ).not.toThrow();
  });

  it('fails when a present section with enabled tools has no server', () => {
    const r = resolver({ servers: { default: { calDav: { server: '', auth: basic('u@example.com') } } } });
    expect(() => r.validate()).toThrow(/calDav tools are enabled but no server is configured/);
  });

  it('fails when a present section has no login user', () => {
    const r = resolver({
      servers: { default: { mail: { server: 'mail.example.com', auth: { type: 'basic', user: '', appPassword: 'x' } } } },
    });
    expect(() => r.validate()).toThrow(/mail has no login user/);
  });

  it('mail (transport imap) passes with split imap/smtp hosts and no server', () => {
    const r = resolver({
      servers: {
        default: {
          mail: {
            server: '',
            transport: 'imap',
            imap: { host: 'imap.gmail.com' },
            smtp: { host: 'smtp.gmail.com' },
            auth: basic('u@gmail.com'),
          },
        },
      },
    });
    expect(() => r.validate()).not.toThrow();
  });

  it('mail defaults to the ox-api transport, which requires the webmail server', () => {
    const acct = resolver({
      servers: { default: { mail: { server: 'webmail.example.com', auth: basic('u@example.com') } } },
    }).getServer();
    expect(acct.mail?.transport).toBe('ox-api');

    // default transport + split hosts only (no server) → invalid for ox-api
    const r = resolver({
      servers: {
        default: {
          mail: { server: '', imap: { host: 'imap.x.com' }, smtp: { host: 'smtp.x.com' }, auth: basic('u@x.com') },
        },
      },
    });
    expect(() => r.validate()).toThrow(/no server is configured/);
  });

  it('env can override the transport', () => {
    const acct = resolver(
      { servers: { default: { mail: { server: 'mail.example.com', auth: basic('u@example.com') } } } },
      { OX_MCP_MAIL_TRANSPORT: 'imap' },
    ).getServer();
    expect(acct.mail?.transport).toBe('imap');
  });

  it('a disabled section does not require a server', () => {
    const r = resolver({
      servers: {
        default: {
          mail: { server: '', enabled: false, auth: basic('u@example.com') },
          calDav: { server: 'dav.example.com', auth: basic('u@example.com') },
        },
      },
    });
    expect(() => r.validate()).not.toThrow();
  });

  it('fails for an account with zero sections', () => {
    const r = resolver({ servers: { empty: {} } });
    expect(() => r.validate()).toThrow(/no sections configured/);
  });

  it('ignores all-empty template sections (first-run default config)', () => {
    // The generated default config has all three sections with empty values —
    // they must not activate tools or trigger validation.
    const r = resolver(
      {
        servers: {
          default: {
            mail: { server: '', auth: { type: 'basic', user: '', appPassword: '' } },
            calDav: { server: '', auth: { type: 'basic', user: '', appPassword: '' } },
            cardDav: { server: '', auth: { type: 'basic', user: '', appPassword: '' } },
          },
        },
      },
      // env fills in only mail — the template calDav/cardDav stay inert
      { OX_MCP_MAIL_SERVER: 'mail.example.com', OX_MCP_MAIL_USER: 'me@example.com', OX_MCP_MAIL_APP_PASSWORD: 'pw' },
    );
    expect(() => r.validate()).not.toThrow();
    expect(r.isToolEnabled('email_search', 'default')).toBe(true);
    expect(r.isToolEnabled('calendar_list', 'default')).toBe(false);
    expect(r.getServer().calDav).toBeUndefined();
  });

  it('a completely untouched template errors with "no sections configured"', () => {
    const r = resolver({
      servers: {
        default: {
          mail: { server: '', auth: { type: 'basic', user: '', appPassword: '' } },
          calDav: { server: '', auth: { type: 'basic', user: '', appPassword: '' } },
        },
      },
    });
    expect(() => r.validate()).toThrow(/no sections configured/);
  });

  it('aggregates errors per account and section', () => {
    const r = resolver({
      servers: {
        good: { calDav: { server: 'dav.example.com', auth: basic('u@example.com') } },
        bad: { mail: { server: '', auth: { type: 'basic', user: '', appPassword: 'x' } } },
      },
    });
    try {
      r.validate();
      expect.unreachable('validate should throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('Account "bad"');
      expect(message).not.toContain('Account "good"');
      expect(message).toContain('no server is configured');
      expect(message).toContain('no login user');
    }
  });
});
