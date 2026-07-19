import { z } from 'zod';
import { GROUPS, GROUP_NAMES, defaultEnabled, featuresOfGroup } from './features.js';

export const DEFAULT_SERVER_ID = 'default';

export const AUTH_TYPES = [
  'basic',
  'xoauth2',
  'oauth2-refresh',
  'oauth2-password',
  'oidc',
] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

// --- Auth (discriminated union; fields lenient so a template config
// validates, with completeness enforced by startup validation / providers).
// Every variant carries its own login `user` — sections are fully
// self-contained because servers like Open-Xchange scope app passwords
// per protocol (Mail / CalDAV / CardDAV are distinct password types). ---
const authBase = { user: z.string().default('') };

const authBasic = z.object({
  ...authBase,
  type: z.literal('basic'),
  appPassword: z.string().default(''),
});
const authXoauth2 = z.object({
  ...authBase,
  type: z.literal('xoauth2'),
  accessToken: z.string().default(''),
});
const authOauthRefresh = z.object({
  ...authBase,
  type: z.literal('oauth2-refresh'),
  clientId: z.string().default(''),
  clientSecret: z.string().optional(),
  refreshToken: z.string().default(''),
  tokenUrl: z.string().default(''),
  scope: z.string().optional(),
});
const authOauthPassword = z.object({
  ...authBase,
  type: z.literal('oauth2-password'),
  clientId: z.string().default(''),
  clientSecret: z.string().optional(),
  password: z.string().default(''),
  tokenUrl: z.string().default(''),
  scope: z.string().optional(),
});
const authOidc = z.object({
  ...authBase,
  type: z.literal('oidc'),
  issuer: z.string().default(''),
  clientId: z.string().default(''),
  clientSecret: z.string().optional(),
  refreshToken: z.string().optional(),
  password: z.string().optional(),
  scope: z.string().optional(),
});

export const authSchema = z.discriminatedUnion('type', [
  authBasic,
  authXoauth2,
  authOauthRefresh,
  authOauthPassword,
  authOidc,
]);
export type RawAuth = z.infer<typeof authSchema>;

const defaultAuth = { type: 'basic', user: '', appPassword: '' } as const;

/** Per-tool feature flags within a section. */
const featuresSchema = z.record(z.string(), z.boolean());

const endpointSchema = z.object({
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  /**
   * Force implicit TLS on (`true`) or STARTTLS (`false`). When omitted, TLS is
   * derived from the port (993/465 ⇒ implicit TLS, anything else ⇒ STARTTLS).
   */
  secure: z.boolean().optional(),
});
export type RawEndpoint = z.infer<typeof endpointSchema>;

const sectionBase = {
  server: z.string().default(''),
  /** Optional group master switch for this account (config level). */
  enabled: z.boolean().optional(),
  auth: authSchema.default(defaultAuth),
  features: featuresSchema.optional(),
};

export const MAIL_TRANSPORTS = ['imap', 'ox-api'] as const;
export type MailTransport = (typeof MAIL_TRANSPORTS)[number];

/**
 * mail section. `transport` is optional and defaults to `"ox-api"` — the
 * Open-Xchange HTTP API (webmail backend), where OX deployments validate app
 * passwords. Set `transport: "imap"` for direct IMAP/SMTP against generic
 * mail hosts (with optional split endpoints below).
 */
const mailSectionSchema = z.object({
  ...sectionBase,
  transport: z.enum(MAIL_TRANSPORTS).default('ox-api'),
  imap: endpointSchema.optional(),
  smtp: endpointSchema.optional(),
});
const davSectionSchema = z.object(sectionBase);

export type RawMailSection = z.infer<typeof mailSectionSchema>;
export type RawDavSection = z.infer<typeof davSectionSchema>;

export const serverSchema = z.object({
  label: z.string().optional(),
  mail: mailSectionSchema.optional(),
  calDav: davSectionSchema.optional(),
  cardDav: davSectionSchema.optional(),
});
export type RawServer = z.infer<typeof serverSchema>;

export const configSchema = z.object({
  $schema: z.string().optional(),
  defaultServer: z.string().default(DEFAULT_SERVER_ID),
  /**
   * Network timeout (seconds) applied to every HTTP/IMAP/SMTP request. Defaults
   * to 300. Overridable per process with `OX_MCP_TIMEOUT_SECONDS`.
   */
  timeoutSeconds: z.number().int().min(1).optional(),
  servers: z.record(z.string(), serverSchema).default({}),
});

export type RawConfig = z.infer<typeof configSchema>;
export type RawConfigInput = z.input<typeof configSchema>;

function defaultFeatures(group: (typeof GROUP_NAMES)[number]): Record<string, boolean> {
  const features: Record<string, boolean> = {};
  for (const f of featuresOfGroup(group)) features[f.key] = defaultEnabled(f.kind);
  return features;
}

/** The default config written on first run: reads enabled, writes disabled. */
export function buildDefaultConfig(): RawConfigInput {
  return {
    $schema: './config.schema.json',
    defaultServer: DEFAULT_SERVER_ID,
    servers: {
      [DEFAULT_SERVER_ID]: {
        mail: { server: '', auth: { ...defaultAuth }, features: defaultFeatures('mail') },
        calDav: { server: '', auth: { ...defaultAuth }, features: defaultFeatures('calDav') },
        cardDav: { server: '', auth: { ...defaultAuth }, features: defaultFeatures('cardDav') },
      },
    },
  };
}

/** Hand-authored JSON Schema written alongside config.json for editor hints. */
export function buildJsonSchema(): unknown {
  const authProps = {
    type: 'object',
    properties: {
      type: { enum: [...AUTH_TYPES] },
      user: { type: 'string', description: 'Login user for this section (usually the mailbox address).' },
    },
    required: ['type'],
  };
  const endpointProps = {
    type: 'object',
    properties: {
      host: { type: 'string' },
      port: { type: 'integer' },
      secure: {
        type: 'boolean',
        description: 'Force implicit TLS (true) or STARTTLS (false). Default: derived from port (993/465 = TLS).',
      },
    },
  };

  const sectionProps: Record<string, unknown> = {};
  for (const group of GROUP_NAMES) {
    const toolProps: Record<string, unknown> = {};
    for (const f of featuresOfGroup(group)) {
      toolProps[f.key] = {
        type: 'boolean',
        description: `Enable ${f.tools.join(', ')} (${f.kind}; default ${defaultEnabled(f.kind)}).`,
      };
    }
    const properties: Record<string, unknown> = {
      server: { type: 'string', description: 'Protocol host for this section.' },
      enabled: { type: 'boolean', description: 'Master switch for all tools in this section.' },
      auth: authProps,
      features: { type: 'object', properties: toolProps },
    };
    if (group === 'mail') {
      properties.imap = { ...endpointProps, description: 'Optional IMAP endpoint override (default: server:993).' };
      properties.smtp = { ...endpointProps, description: 'Optional SMTP endpoint override (default: server:465).' };
    }
    sectionProps[group] = {
      type: 'object',
      description: `${GROUPS[group].description} Section absent = its tools are disabled.`,
      properties,
    };
  }

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'ox-mcp config',
    type: 'object',
    properties: {
      defaultServer: {
        type: 'string',
        description: 'Id of the server used when a tool call omits `server`.',
      },
      timeoutSeconds: {
        type: 'integer',
        description: 'Network timeout (seconds) for all requests. Default 300; env override OX_MCP_TIMEOUT_SECONDS.',
      },
      servers: {
        type: 'object',
        description: 'Accounts keyed by server id. Each account has self-contained mail/calDav/cardDav sections.',
        additionalProperties: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            ...sectionProps,
          },
        },
      },
    },
  };
}
