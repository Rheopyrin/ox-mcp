import { describe, expect, it } from 'vitest';
import { envAccountIds, parseBool, sectionFieldEnv, sectionPresentInEnv } from '../../src/config/env.js';

describe('parseBool', () => {
  it('parses truthy tokens', () => {
    for (const v of ['true', '1', 'yes', 'on', 'TRUE', ' Yes ']) {
      expect(parseBool(v)).toBe(true);
    }
  });
  it('parses falsy tokens', () => {
    for (const v of ['false', '0', 'no', 'off', 'OFF']) {
      expect(parseBool(v)).toBe(false);
    }
  });
  it('returns undefined for unset or unrecognized', () => {
    expect(parseBool(undefined)).toBeUndefined();
    expect(parseBool('maybe')).toBeUndefined();
  });
});

describe('envAccountIds', () => {
  it('parses OX_MCP_ACCOUNTS list, lowercased', () => {
    expect(new Set(envAccountIds({ OX_MCP_ACCOUNTS: 'Work, Personal ,,' }))).toEqual(
      new Set(['work', 'personal']),
    );
  });
  it('implies default when a non-indexed section var is present', () => {
    expect(envAccountIds({ OX_MCP_MAIL_USER: 'x@y.com' })).toContain('default');
    expect(envAccountIds({ OX_MCP_CALDAV_SERVER: 'dav.example.com' })).toContain('default');
  });
  it('is empty with no relevant env', () => {
    expect(envAccountIds({})).toEqual([]);
  });
});

describe('sectionFieldEnv / sectionPresentInEnv', () => {
  it('reads non-indexed fields for the default account', () => {
    const env = { OX_MCP_MAIL_SERVER: 'mail.example.com', OX_MCP_CARDDAV_APP_PASSWORD: 'pw' };
    expect(sectionFieldEnv(env, 'default', 'mail', 'SERVER')).toBe('mail.example.com');
    expect(sectionFieldEnv(env, 'default', 'cardDav', 'APP_PASSWORD')).toBe('pw');
    expect(sectionFieldEnv(env, 'default', 'calDav', 'SERVER')).toBeUndefined();
  });

  it('reads indexed fields for named accounts', () => {
    const env = { OX_MCP_WORK_CALDAV_USER: 'w@example.com' };
    expect(sectionFieldEnv(env, 'work', 'calDav', 'USER')).toBe('w@example.com');
    expect(sectionFieldEnv(env, 'default', 'calDav', 'USER')).toBeUndefined();
  });

  it('detects section presence per account and section', () => {
    const env = { OX_MCP_WORK_MAIL_SMTP_HOST: 'smtp.work.com' };
    expect(sectionPresentInEnv(env, 'work', 'mail')).toBe(true);
    expect(sectionPresentInEnv(env, 'work', 'calDav')).toBe(false);
    expect(sectionPresentInEnv(env, 'default', 'mail')).toBe(false);
  });
});
