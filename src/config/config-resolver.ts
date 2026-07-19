import {
  DEFAULT_SERVER_ID,
  AUTH_TYPES,
  MAIL_TRANSPORTS,
  type AuthType,
  type MailTransport,
  type RawAuth,
  type RawConfig,
  type RawDavSection,
  type RawMailSection,
} from './config.schema.js';
import {
  FEATURE_BY_TOOL,
  GROUPS,
  GROUP_NAMES,
  defaultEnabled,
  featuresOfGroup,
  type FeatureDef,
  type FeatureGroup,
} from './features.js';
import {
  accountFlagEnv,
  envAccountIds,
  envDefaultServer,
  envTimeoutSeconds,
  globalFlagEnv,
  parseBool,
  sectionFieldEnv,
  sectionPresentInEnv,
  type Env,
  type SectionField,
} from './env.js';
import { DEFAULT_TIMEOUT_SECONDS } from '../core/http.js';

export type ResolvedAuth =
  | { type: 'basic'; user: string; appPassword: string }
  | { type: 'xoauth2'; user: string; accessToken: string }
  | {
      type: 'oauth2-refresh';
      user: string;
      clientId: string;
      clientSecret?: string;
      refreshToken: string;
      tokenUrl: string;
      scope?: string;
    }
  | {
      type: 'oauth2-password';
      user: string;
      clientId: string;
      clientSecret?: string;
      password: string;
      tokenUrl: string;
      scope?: string;
    }
  | {
      type: 'oidc';
      user: string;
      issuer: string;
      clientId: string;
      clientSecret?: string;
      refreshToken?: string;
      password?: string;
      scope?: string;
    };

export interface ResolvedSection {
  server: string;
  auth: ResolvedAuth;
}

export interface ResolvedEndpoint {
  host: string;
  port: number;
  /** true = implicit TLS; false = STARTTLS upgrade. Derived from the port. */
  secure: boolean;
}

export interface ResolvedMailSection extends ResolvedSection {
  /** `imap` = direct IMAP/SMTP; `ox-api` = Open-Xchange HTTP API (webmail backend). */
  transport: MailTransport;
  imap: ResolvedEndpoint;
  smtp: ResolvedEndpoint;
}

export interface ResolvedAccount {
  id: string;
  label: string;
  mail?: ResolvedMailSection;
  calDav?: ResolvedSection;
  cardDav?: ResolvedSection;
}

const IMAP_TLS_PORT = 993;
const SMTP_TLS_PORT = 465;

/**
 * Resolves the effective configuration by overlaying environment variables on
 * top of the parsed config file. Accounts are made of self-contained
 * mail/calDav/cardDav sections, each with its own server, auth (incl. login
 * user), and feature flags. An absent section means its tools are disabled.
 */
export class ConfigResolver {
  private readonly ids: string[];

  constructor(
    private readonly config: RawConfig,
    private readonly env: Env,
  ) {
    const set = new Set<string>([...Object.keys(config.servers ?? {}), ...envAccountIds(env)]);
    if (set.size === 0) set.add(DEFAULT_SERVER_ID);
    this.ids = [...set];
  }

  serverIds(): string[] {
    return [...this.ids];
  }

  get defaultServerId(): string {
    return envDefaultServer(this.env) ?? this.config.defaultServer ?? DEFAULT_SERVER_ID;
  }

  /** Network request timeout in milliseconds (env > config > 300s default). */
  get timeoutMs(): number {
    const seconds = envTimeoutSeconds(this.env) ?? this.config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    return seconds * 1000;
  }

  hasServer(id: string): boolean {
    return this.ids.includes(id);
  }

  /** Resolve an account, defaulting to the configured default server. */
  getServer(id?: string): ResolvedAccount {
    const target = id ?? this.defaultServerId;
    if (!this.ids.includes(target)) {
      throw new Error(
        `Unknown server "${target}". Configured servers: ${this.ids.join(', ') || '(none)'}`,
      );
    }
    return this.resolveAccount(target);
  }

  getServers(): ResolvedAccount[] {
    return this.ids.map((id) => this.resolveAccount(id));
  }

  /** Whether the tool is enabled for a specific account (true for ungated tools). */
  isToolEnabled(toolName: string, serverId: string): boolean {
    const feature = FEATURE_BY_TOOL.get(toolName);
    if (!feature) return true;
    return this.resolveFlag(feature, serverId);
  }

  /** Whether the tool is enabled for at least one account (tool visibility). */
  isToolEnabledForAny(toolName: string): boolean {
    const feature = FEATURE_BY_TOOL.get(toolName);
    if (!feature) return true;
    return this.ids.some((id) => this.resolveFlag(feature, id));
  }

  /**
   * Strict startup validation. For every account: at least one section must be
   * configured; each present section with enabled tools needs its endpoint(s)
   * and a login user. Throws one aggregated error.
   */
  validate(): void {
    const errors: string[] = [];
    for (const id of this.ids) {
      const present = GROUP_NAMES.filter((group) => this.sectionPresent(id, group));
      if (present.length === 0) {
        errors.push(
          `Account "${id}": no sections configured. Add a mail/calDav/cardDav section in config.json or set OX_MCP_*_SERVER env vars.`,
        );
        continue;
      }
      const account = this.resolveAccount(id);
      for (const group of present) {
        if (!featuresOfGroup(group).some((f) => this.resolveFlag(f, id))) continue;
        const section = account[group];
        if (!section) continue;
        const missingHost =
          group === 'mail'
            ? account.mail!.transport === 'ox-api'
              ? !account.mail!.server // ox-api needs the webmail host itself
              : !(account.mail!.imap.host && account.mail!.smtp.host)
            : !section.server;
        if (missingHost) {
          errors.push(
            `Account "${id}": ${group} tools are enabled but no server is configured.\n` +
              `  Fix: set servers.${id}.${group}.server (or OX_MCP_${GROUPS[group].envSuffix}_SERVER), ` +
              `or disable the section (servers.${id}.${group}.enabled = false / OX_MCP_ENABLE_${GROUPS[group].envSuffix}=false).`,
          );
        }
        if (!section.auth.user) {
          errors.push(
            `Account "${id}": ${group} has no login user. Set servers.${id}.${group}.auth.user or OX_MCP_${GROUPS[group].envSuffix}_USER.`,
          );
        }
      }
    }
    if (errors.length > 0) {
      throw new Error(`Invalid configuration:\n${errors.join('\n')}`);
    }
  }

  private sectionPresent(id: string, group: FeatureGroup): boolean {
    const cfg = this.config.servers?.[id]?.[group];
    return (cfg !== undefined && sectionConfigured(cfg)) || sectionPresentInEnv(this.env, id, group);
  }

  /**
   * Flag precedence — env ALWAYS beats config, first defined wins:
   * acct env tool > acct env group > global env tool > global env group >
   * section config tool > section config `enabled` > kind default.
   * Absent section ⇒ always disabled.
   */
  private resolveFlag(feature: FeatureDef, serverId: string): boolean {
    if (!this.sectionPresent(serverId, feature.group)) return false;
    const groupSuffix = GROUPS[feature.group].envSuffix;

    const accountEnvTool = accountFlagEnv(this.env, serverId, feature.envSuffix);
    if (accountEnvTool !== undefined) return accountEnvTool;
    const accountEnvGroup = accountFlagEnv(this.env, serverId, groupSuffix);
    if (accountEnvGroup !== undefined) return accountEnvGroup;

    const globalEnvTool = globalFlagEnv(this.env, feature.envSuffix);
    if (globalEnvTool !== undefined) return globalEnvTool;
    const globalEnvGroup = globalFlagEnv(this.env, groupSuffix);
    if (globalEnvGroup !== undefined) return globalEnvGroup;

    const section = this.config.servers?.[serverId]?.[feature.group];
    const configTool = section?.features?.[feature.key];
    if (configTool !== undefined) return configTool;
    if (section?.enabled !== undefined) return section.enabled;

    return defaultEnabled(feature.kind);
  }

  private resolveAccount(id: string): ResolvedAccount {
    const cfg = this.config.servers?.[id];
    return {
      id,
      label: cfg?.label ?? id,
      mail: this.sectionPresent(id, 'mail') ? this.resolveMail(id, cfg?.mail) : undefined,
      calDav: this.sectionPresent(id, 'calDav')
        ? this.resolveSection(id, 'calDav', cfg?.calDav)
        : undefined,
      cardDav: this.sectionPresent(id, 'cardDav')
        ? this.resolveSection(id, 'cardDav', cfg?.cardDav)
        : undefined,
    };
  }

  private resolveSection(
    id: string,
    group: FeatureGroup,
    cfg: RawDavSection | RawMailSection | undefined,
  ): ResolvedSection {
    const server = sectionFieldEnv(this.env, id, group, 'SERVER') ?? cfg?.server ?? '';
    return { server, auth: this.resolveAuth(id, group, cfg?.auth) };
  }

  private resolveMail(id: string, cfg: RawMailSection | undefined): ResolvedMailSection {
    const base = this.resolveSection(id, 'mail', cfg);
    const transport = coerceTransport(sectionFieldEnv(this.env, id, 'mail', 'TRANSPORT')) ?? cfg?.transport ?? 'ox-api';
    const imapPort =
      parsePort(sectionFieldEnv(this.env, id, 'mail', 'IMAP_PORT')) ??
      cfg?.imap?.port ??
      IMAP_TLS_PORT;
    const smtpPort =
      parsePort(sectionFieldEnv(this.env, id, 'mail', 'SMTP_PORT')) ??
      cfg?.smtp?.port ??
      SMTP_TLS_PORT;
    return {
      ...base,
      transport,
      imap: {
        host: sectionFieldEnv(this.env, id, 'mail', 'IMAP_HOST') ?? cfg?.imap?.host ?? base.server,
        port: imapPort,
        secure: resolveSecure(sectionFieldEnv(this.env, id, 'mail', 'IMAP_SECURE'), cfg?.imap?.secure, imapPort === IMAP_TLS_PORT),
      },
      smtp: {
        host: sectionFieldEnv(this.env, id, 'mail', 'SMTP_HOST') ?? cfg?.smtp?.host ?? base.server,
        port: smtpPort,
        secure: resolveSecure(sectionFieldEnv(this.env, id, 'mail', 'SMTP_SECURE'), cfg?.smtp?.secure, smtpPort === SMTP_TLS_PORT),
      },
    };
  }

  private resolveAuth(id: string, group: FeatureGroup, cfgAuth: RawAuth | undefined): ResolvedAuth {
    const envType = coerceAuthType(sectionFieldEnv(this.env, id, group, 'AUTH_TYPE'));
    const type: AuthType = envType ?? cfgAuth?.type ?? 'basic';
    // The login user is section identity — env wins, config applies regardless
    // of auth type. Other fields are only reused when the type matches.
    const user = sectionFieldEnv(this.env, id, group, 'USER') ?? cfgAuth?.user ?? '';
    const matched = cfgAuth && cfgAuth.type === type ? cfgAuth : undefined;

    const field = (name: SectionField, cfgValue: string | undefined) =>
      sectionFieldEnv(this.env, id, group, name) ?? cfgValue ?? '';
    const optField = (name: SectionField, cfgValue: string | undefined): string | undefined =>
      sectionFieldEnv(this.env, id, group, name) ?? cfgValue;

    switch (type) {
      case 'basic':
        return {
          type,
          user,
          appPassword: field('APP_PASSWORD', matched?.type === 'basic' ? matched.appPassword : ''),
        };
      case 'xoauth2':
        return {
          type,
          user,
          accessToken: field(
            'ACCESS_TOKEN',
            matched?.type === 'xoauth2' ? matched.accessToken : '',
          ),
        };
      case 'oauth2-refresh': {
        const a = matched?.type === 'oauth2-refresh' ? matched : undefined;
        return {
          type,
          user,
          clientId: field('CLIENT_ID', a?.clientId),
          clientSecret: optField('CLIENT_SECRET', a?.clientSecret),
          refreshToken: field('REFRESH_TOKEN', a?.refreshToken),
          tokenUrl: field('TOKEN_URL', a?.tokenUrl),
          scope: optField('SCOPE', a?.scope),
        };
      }
      case 'oauth2-password': {
        const a = matched?.type === 'oauth2-password' ? matched : undefined;
        return {
          type,
          user,
          clientId: field('CLIENT_ID', a?.clientId),
          clientSecret: optField('CLIENT_SECRET', a?.clientSecret),
          password: field('PASSWORD', a?.password),
          tokenUrl: field('TOKEN_URL', a?.tokenUrl),
          scope: optField('SCOPE', a?.scope),
        };
      }
      case 'oidc': {
        const a = matched?.type === 'oidc' ? matched : undefined;
        return {
          type,
          user,
          issuer: field('ISSUER', a?.issuer),
          clientId: field('CLIENT_ID', a?.clientId),
          clientSecret: optField('CLIENT_SECRET', a?.clientSecret),
          refreshToken: optField('REFRESH_TOKEN', a?.refreshToken),
          password: optField('PASSWORD', a?.password),
          scope: optField('SCOPE', a?.scope),
        };
      }
    }
  }
}

/**
 * Whether a config section is actually filled in. The first-run default config
 * writes empty template sections (empty server/user/password) — those must not
 * count as configured, or a fresh install could never start. A section
 * activates once it has a server (or mail endpoint hosts), any credential
 * value, or an explicit `enabled: true`.
 */
function sectionConfigured(cfg: RawDavSection | RawMailSection): boolean {
  if (cfg.server) return true;
  if (cfg.enabled === true) return true;
  const mail = cfg as RawMailSection;
  if (mail.imap?.host || mail.smtp?.host) return true;
  const auth = cfg.auth as Record<string, unknown>;
  return [
    'user',
    'appPassword',
    'accessToken',
    'clientId',
    'clientSecret',
    'refreshToken',
    'tokenUrl',
    'issuer',
    'password',
  ].some((key) => typeof auth[key] === 'string' && auth[key] !== '');
}

/** Fetch a section from a resolved account or fail with an actionable error. */
export function requireSection<G extends FeatureGroup>(
  account: ResolvedAccount,
  group: G,
): NonNullable<ResolvedAccount[G]> {
  const section = account[group];
  if (!section) {
    throw new Error(
      `Server "${account.id}" has no ${group} section configured. Add servers.${account.id}.${group} to config.json or set OX_MCP_${GROUPS[group].envSuffix}_* env vars.`,
    );
  }
  return section as NonNullable<ResolvedAccount[G]>;
}

function coerceAuthType(raw: string | undefined): AuthType | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  return (AUTH_TYPES as readonly string[]).includes(v) ? (v as AuthType) : undefined;
}

function coerceTransport(raw: string | undefined): MailTransport | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  return (MAIL_TRANSPORTS as readonly string[]).includes(v) ? (v as MailTransport) : undefined;
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

/** Explicit TLS override: env wins, then config, then the port-derived default. */
function resolveSecure(envRaw: string | undefined, cfgValue: boolean | undefined, portDefault: boolean): boolean {
  return parseBool(envRaw) ?? cfgValue ?? portDefault;
}
