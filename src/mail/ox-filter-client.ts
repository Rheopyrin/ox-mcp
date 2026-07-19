import type { ResolvedMailSection } from '../config/config-resolver.js';
import type { FilterAction, FilterCondition, FilterRule, FilterRuleInput } from './sieve-client.js';
import { oxApiRequest, type FetchFn, type OxSessionManager } from './ox-session.js';
import { oxFolderId } from './ox-http-client.js';

interface OxTest {
  id: string;
  comparison?: string;
  headers?: string[];
  values?: string[];
  tests?: OxTest[];
}

interface OxActionCmd {
  id: string;
  into?: string;
  to?: string;
  flags?: string[];
}

interface OxRule {
  id?: number;
  position?: number;
  rulename?: string;
  active?: boolean;
  flags?: string[];
  test?: OxTest;
  actioncmds?: OxActionCmd[];
}

const FIELD_TO_HEADER: Record<Exclude<FilterCondition['field'], 'header'>, string> = {
  from: 'From',
  to: 'To',
  subject: 'Subject',
};

/**
 * Mail filter management over the OX HTTP API `mailfilter/v2` module — the
 * filter counterpart of the ox-api mail transport. The OX middleware edits the
 * account's actual sieve rules (the same ones webmail shows), so unlike the
 * ManageSieve backend this lists and updates existing rules too.
 */
export class OxFilterClient {
  constructor(
    private readonly section: ResolvedMailSection,
    private readonly sessions: OxSessionManager,
    private readonly contextId: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async listFilters(): Promise<FilterRule[]> {
    const rules = await this.request<OxRule[]>('mailfilter/v2?action=list');
    return (rules ?? []).map(fromOxRule);
  }

  async createFilter(input: FilterRuleInput): Promise<FilterRule> {
    const id = await this.request<number>('mailfilter/v2?action=new', {
      method: 'PUT',
      body: JSON.stringify(toOxRule(input)),
    });
    return { ...input, id: String(id) };
  }

  async updateFilter(id: string, input: FilterRuleInput): Promise<FilterRule> {
    await this.request('mailfilter/v2?action=update', {
      method: 'PUT',
      body: JSON.stringify({ ...toOxRule(input), id: Number(id) }),
    });
    return { ...input, id };
  }

  private request<T>(pathAndQuery: string, init: { method?: string; body?: string } = {}): Promise<T> {
    return oxApiRequest<T>(
      {
        host: this.section.server,
        auth: this.section.auth,
        contextId: this.contextId,
        sessions: this.sessions,
        fetchFn: this.fetchFn,
      },
      pathAndQuery,
      init,
    );
  }
}

/** Map our rule model onto an OX mailfilter rule. */
export function toOxRule(input: FilterRuleInput): OxRule {
  const tests = input.conditions.map(toOxTest);
  const test = tests.length === 1 ? tests[0] : { id: input.matchAll ? 'allof' : 'anyof', tests };

  const actioncmds: OxActionCmd[] = [toOxAction(input.action)];
  if (input.stop) actioncmds.push({ id: 'stop' });

  return { rulename: input.name, active: true, flags: [], test, actioncmds };
}

function toOxTest(c: FilterCondition): OxTest {
  const header = c.field === 'header' ? (c.header ?? '') : FIELD_TO_HEADER[c.field];
  return { id: 'header', comparison: 'contains', headers: [header], values: [c.contains] };
}

function toOxAction(action: FilterAction): OxActionCmd {
  switch (action.type) {
    case 'fileinto':
      return { id: 'move', into: oxFolderId(action.folder ?? '') };
    case 'discard':
      return { id: 'discard' };
    case 'markRead':
      return { id: 'addflags', flags: ['\\seen'] };
    case 'redirect':
      return { id: 'redirect', to: action.address ?? '' };
    case 'other':
      throw new Error('Action type "other" is read-only and cannot be written back.');
  }
}

/** Map an OX rule back onto our model (best effort — OX supports more). */
export function fromOxRule(rule: OxRule): FilterRule {
  const actions = rule.actioncmds ?? [];
  return {
    id: String(rule.id ?? ''),
    name: rule.rulename ?? '(unnamed)',
    active: rule.active,
    conditions: fromOxTest(rule.test),
    matchAll: rule.test?.id === 'allof' ? true : undefined,
    action: fromOxActions(actions),
    stop: actions.some((a) => a.id === 'stop') || undefined,
  };
}

function fromOxTest(test: OxTest | undefined): FilterCondition[] {
  if (!test) return [];
  if (test.id === 'anyof' || test.id === 'allof') {
    return (test.tests ?? []).flatMap((t) => fromOxTest(t));
  }
  const contains = test.values?.[0] ?? '';
  if (test.id === 'from' || test.id === 'to' || test.id === 'subject') {
    return [{ field: test.id, contains }];
  }
  if (test.id === 'header') {
    const header = test.headers?.[0] ?? '';
    const known = (Object.entries(FIELD_TO_HEADER) as [Exclude<FilterCondition['field'], 'header'>, string][])
      .find(([, h]) => h.toLowerCase() === header.toLowerCase())?.[0];
    return [known ? { field: known, contains } : { field: 'header', header, contains }];
  }
  // Tests our model can't express (date, size, envelope, …) — surface them
  // so the rule is at least visible and diffable.
  return [{ field: 'header', header: `(ox:${test.id})`, contains }];
}

function fromOxActions(actions: OxActionCmd[]): FilterAction {
  for (const a of actions) {
    switch (a.id) {
      case 'move':
        return { type: 'fileinto', folder: a.into };
      case 'discard':
        return { type: 'discard' };
      case 'addflags':
        if (a.flags?.some((f) => f.toLowerCase() === '\\seen')) return { type: 'markRead' };
        break;
      case 'redirect':
        return { type: 'redirect', address: a.to };
    }
  }
  return { type: 'other', description: actions.map((a) => a.id).join(', ') || '(none)' };
}
