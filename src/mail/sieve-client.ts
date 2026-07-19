import { randomUUID } from 'node:crypto';
import type { ResolvedMailSection } from '../config/config-resolver.js';
import type { AuthProvider } from '../auth/auth-provider.js';
import { TcpSieveTransport } from './sieve-transport.js';

export const SIEVE_SCRIPT_NAME = 'ox-mcp';
const RULE_MARKER = /^# ox-mcp:rule:([A-Za-z0-9-]+):([A-Za-z0-9+/=]+)\s*$/gm;

export interface FilterCondition {
  field: 'from' | 'to' | 'subject' | 'header';
  /** Header name, required when field = "header". */
  header?: string;
  contains: string;
}

export interface FilterAction {
  /** `other` appears only when listing backend rules our model can't express. */
  type: 'fileinto' | 'discard' | 'markRead' | 'redirect' | 'other';
  /** Target folder, required for "fileinto". */
  folder?: string;
  /** Target address, required for "redirect". */
  address?: string;
  /** For "other": the raw backend action ids. */
  description?: string;
}

export interface FilterRuleInput {
  name: string;
  conditions: FilterCondition[];
  /** true = allof (AND); default anyof (OR). */
  matchAll?: boolean;
  action: FilterAction;
  /** Stop processing further rules after this one matches. */
  stop?: boolean;
}

export interface FilterRule extends FilterRuleInput {
  id: string;
  /** Whether the rule is active on the server (OX backend only). */
  active?: boolean;
}

/** Minimal ManageSieve session used by the client. */
export interface SieveSession {
  listScripts(): Promise<{ name: string; active: boolean }[]>;
  getScript(name: string): Promise<string | undefined>;
  putScript(name: string, content: string): Promise<void>;
  setActive(name: string): Promise<void>;
  close(): Promise<void>;
}

export type SieveSessionFactory = (params: {
  host: string;
  user: string;
  pass: string;
}) => Promise<SieveSession>;

const defaultSessionFactory: SieveSessionFactory = async (params) => {
  const transport = new TcpSieveTransport(params.host, 4190, {
    user: params.user,
    pass: params.pass,
  });
  await transport.connect();
  return transport;
};

/**
 * Manages server-side mail filters as a dedicated sieve script (`ox-mcp`).
 * Each rule is serialized into the script prefixed by a marker comment that
 * embeds the rule as base64 JSON, so listing/updating never needs to parse
 * sieve syntax. Putting the script also activates it.
 *
 * NOTE: activating the ox-mcp script makes it the account's active sieve
 * script (servers allow one active script at a time).
 */
export class SieveClient {
  constructor(
    private readonly section: ResolvedMailSection,
    private readonly authProvider: AuthProvider,
    private readonly sessionFactory: SieveSessionFactory = defaultSessionFactory,
  ) {}

  async listFilters(): Promise<FilterRule[]> {
    const session = await this.connect();
    try {
      return await this.readRules(session);
    } finally {
      await session.close();
    }
  }

  async createFilter(input: FilterRuleInput): Promise<FilterRule> {
    const rule: FilterRule = { ...input, id: randomUUID().slice(0, 8) };
    validateRule(rule);
    const session = await this.connect();
    try {
      const rules = await this.readRules(session);
      rules.push(rule);
      await this.writeRules(session, rules);
      return rule;
    } finally {
      await session.close();
    }
  }

  async updateFilter(id: string, input: FilterRuleInput): Promise<FilterRule> {
    const rule: FilterRule = { ...input, id };
    validateRule(rule);
    const session = await this.connect();
    try {
      const rules = await this.readRules(session);
      const index = rules.findIndex((r) => r.id === id);
      if (index === -1) {
        throw new Error(
          `No filter with id "${id}". Existing: ${rules.map((r) => r.id).join(', ') || '(none)'}`,
        );
      }
      rules[index] = rule;
      await this.writeRules(session, rules);
      return rule;
    } finally {
      await session.close();
    }
  }

  private async connect(): Promise<SieveSession> {
    const auth = await this.authProvider.getImapAuth();
    if (!('pass' in auth)) {
      throw new Error(
        'Mail filters require basic (app password) authentication — ManageSieve token auth is not supported.',
      );
    }
    return this.sessionFactory({ host: this.section.server || this.section.imap.host, user: auth.user, pass: auth.pass });
  }

  private async readRules(session: SieveSession): Promise<FilterRule[]> {
    const script = await session.getScript(SIEVE_SCRIPT_NAME);
    return script ? parseRules(script) : [];
  }

  private async writeRules(session: SieveSession, rules: FilterRule[]): Promise<void> {
    await session.putScript(SIEVE_SCRIPT_NAME, buildScript(rules));
    await session.setActive(SIEVE_SCRIPT_NAME);
  }
}

export function parseRules(script: string): FilterRule[] {
  const rules: FilterRule[] = [];
  for (const match of script.matchAll(RULE_MARKER)) {
    try {
      const decoded = JSON.parse(Buffer.from(match[2], 'base64').toString('utf8')) as FilterRule;
      if (decoded.id === match[1]) rules.push(decoded);
    } catch {
      // Ignore corrupted markers; the rule simply disappears from the list.
    }
  }
  return rules;
}

export function buildScript(rules: FilterRule[]): string {
  const capabilities = new Set<string>();
  for (const rule of rules) {
    if (rule.action.type === 'fileinto') capabilities.add('fileinto');
    if (rule.action.type === 'markRead') capabilities.add('imap4flags');
  }

  const lines: string[] = ['# Managed by ox-mcp — do not edit rule markers by hand.'];
  if (capabilities.size > 0) {
    lines.push(`require [${[...capabilities].map((c) => `"${c}"`).join(', ')}];`);
  }
  for (const rule of rules) {
    const encoded = Buffer.from(JSON.stringify(rule), 'utf8').toString('base64');
    lines.push('', `# ox-mcp:rule:${rule.id}:${encoded}`, ...renderRule(rule));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function renderRule(rule: FilterRule): string[] {
  const tests = rule.conditions.map((c) => {
    const header = c.field === 'header' ? (c.header ?? '') : c.field;
    return `header :contains ${quote(header)} ${quote(c.contains)}`;
  });
  const combinator = rule.matchAll ? 'allof' : 'anyof';
  const test = tests.length === 1 ? tests[0] : `${combinator} (${tests.join(', ')})`;

  const body: string[] = [];
  switch (rule.action.type) {
    case 'fileinto':
      body.push(`  fileinto ${quote(rule.action.folder ?? '')};`);
      break;
    case 'discard':
      body.push('  discard;');
      break;
    case 'markRead':
      body.push('  addflag "\\\\Seen";');
      break;
    case 'redirect':
      body.push(`  redirect ${quote(rule.action.address ?? '')};`);
      break;
  }
  if (rule.stop) body.push('  stop;');

  return [`if ${test} {`, ...body, '}'];
}

function validateRule(rule: FilterRule): void {
  if (rule.conditions.length === 0) throw new Error('A filter needs at least one condition.');
  for (const c of rule.conditions) {
    if (c.field === 'header' && !c.header) {
      throw new Error('Conditions with field "header" must set the header name.');
    }
  }
  if (rule.action.type === 'fileinto' && !rule.action.folder) {
    throw new Error('Action "fileinto" requires a target folder.');
  }
  if (rule.action.type === 'redirect' && !rule.action.address) {
    throw new Error('Action "redirect" requires a target address.');
  }
  if (rule.action.type === 'other') {
    throw new Error('Action type "other" is read-only (it represents backend actions this model cannot express).');
  }
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
