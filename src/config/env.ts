import { DEFAULT_SERVER_ID } from './config.schema.js';
import { GROUPS, GROUP_NAMES, type FeatureGroup } from './features.js';

export type Env = Record<string, string | undefined>;

export const ENV_PREFIX = 'OX_MCP_';

/**
 * Per-section field env suffixes, read as `OX_MCP_[ID_]<SECTION>_<FIELD>`
 * (SECTION ∈ MAIL | CALDAV | CARDDAV). The `default` account uses the
 * non-indexed form (`OX_MCP_MAIL_SERVER`); named accounts are indexed
 * (`OX_MCP_WORK_MAIL_SERVER`).
 */
export const SECTION_FIELDS = [
  'SERVER',
  'USER',
  'AUTH_TYPE',
  'APP_PASSWORD',
  'ACCESS_TOKEN',
  'CLIENT_ID',
  'CLIENT_SECRET',
  'REFRESH_TOKEN',
  'TOKEN_URL',
  'ISSUER',
  'SCOPE',
  'PASSWORD',
  // mail-only transport overrides
  'TRANSPORT',
  'IMAP_HOST',
  'IMAP_PORT',
  'IMAP_SECURE',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
] as const;
export type SectionField = (typeof SECTION_FIELDS)[number];

export function parseBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return undefined;
}

function idSegment(id: string): string {
  return id === DEFAULT_SERVER_ID ? '' : `${normalizeId(id)}_`;
}

export function normalizeId(id: string): string {
  return id.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

export function sectionFieldEnv(
  env: Env,
  id: string,
  group: FeatureGroup,
  field: SectionField,
): string | undefined {
  return env[`${ENV_PREFIX}${idSegment(id)}${GROUPS[group].envSuffix}_${field}`];
}

/** Whether any env var defines this section for this account. */
export function sectionPresentInEnv(env: Env, id: string, group: FeatureGroup): boolean {
  return SECTION_FIELDS.some((field) => sectionFieldEnv(env, id, group, field) !== undefined);
}

/**
 * Per-account feature flag. Always indexed by id — including the `default`
 * account (`OX_MCP_DEFAULT_ENABLE_EMAIL_SEND`) — so it never collides with the
 * global flag (`OX_MCP_ENABLE_EMAIL_SEND`).
 */
export function accountFlagEnv(env: Env, id: string, suffix: string): boolean | undefined {
  return parseBool(env[`${ENV_PREFIX}${normalizeId(id)}_ENABLE_${suffix}`]);
}

export function globalFlagEnv(env: Env, suffix: string): boolean | undefined {
  return parseBool(env[`${ENV_PREFIX}ENABLE_${suffix}`]);
}

export function envDefaultServer(env: Env): string | undefined {
  const raw = env[`${ENV_PREFIX}DEFAULT_SERVER`];
  return raw?.trim() || undefined;
}

/** Process-wide request timeout override (`OX_MCP_TIMEOUT_SECONDS`), in seconds. */
export function envTimeoutSeconds(env: Env): number | undefined {
  const raw = env[`${ENV_PREFIX}TIMEOUT_SECONDS`];
  if (raw === undefined) return undefined;
  const seconds = Number.parseInt(raw, 10);
  return Number.isInteger(seconds) && seconds > 0 ? seconds : undefined;
}

/** Account ids declared/implied by env: `OX_MCP_ACCOUNTS` plus an implied
 * `default` when any non-indexed section var is present. */
export function envAccountIds(env: Env): string[] {
  const ids = new Set<string>();
  const list = env[`${ENV_PREFIX}ACCOUNTS`];
  if (list) {
    for (const token of list.split(',')) {
      const id = token.trim().toLowerCase();
      if (id) ids.add(id);
    }
  }
  if (GROUP_NAMES.some((group) => sectionPresentInEnv(env, DEFAULT_SERVER_ID, group))) {
    ids.add(DEFAULT_SERVER_ID);
  }
  return [...ids];
}
