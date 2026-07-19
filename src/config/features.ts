/**
 * Single source of truth for feature groups, features, and the tools they gate.
 *
 * Tools are named `<group>_<action>` (`email_send`, `calendar_list_events`,
 * `contact_list`). Features are grouped; each feature gates one or more tools
 * (e.g. `calendar.respondEvent` gates accept/decline/tentative). Identifiers:
 *  - `key`       camelCase key inside the section's features object, e.g. `filterList`
 *  - `envSuffix` UPPER env-var suffix, e.g. `EMAIL_FILTER_LIST`
 *    (group master switch: `OX_MCP_ENABLE_MAIL` / `_CALDAV` / `_CARDDAV`)
 *
 * Defaults follow `kind`: read features default enabled, writes disabled.
 */
export type FeatureKind = 'read' | 'write';
/** Feature groups correspond 1:1 to per-account config sections. */
export type FeatureGroup = 'mail' | 'calDav' | 'cardDav';

export interface GroupDef {
  /** MCP tool name prefix for this group (tool names are LLM-facing and stable). */
  toolPrefix: string;
  envSuffix: string;
  description: string;
}

export const GROUPS: Record<FeatureGroup, GroupDef> = {
  mail: {
    toolPrefix: 'email_',
    envSuffix: 'MAIL',
    description: 'Email via IMAP/SMTP, and mail filters via ManageSieve.',
  },
  calDav: {
    toolPrefix: 'calendar_',
    envSuffix: 'CALDAV',
    description: 'Calendars, events, free/busy, and invitations via CalDAV.',
  },
  cardDav: {
    toolPrefix: 'contact_',
    envSuffix: 'CARDDAV',
    description: 'Address books and contacts via CardDAV.',
  },
};

export const GROUP_NAMES = Object.keys(GROUPS) as FeatureGroup[];

export interface FeatureDef {
  group: FeatureGroup;
  /** camelCase key within the group's config features object. */
  key: string;
  envSuffix: string;
  kind: FeatureKind;
  /** MCP tool names gated by this feature (usually one, sometimes several). */
  tools: string[];
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Single-tool feature: key derives from the tool name minus the group prefix. */
function tool(group: FeatureGroup, name: string, kind: FeatureKind): FeatureDef {
  const prefix = GROUPS[group].toolPrefix;
  if (!name.startsWith(prefix)) {
    throw new Error(`Tool "${name}" must start with "${prefix}"`);
  }
  return {
    group,
    key: snakeToCamel(name.slice(prefix.length)),
    envSuffix: name.toUpperCase(),
    kind,
    tools: [name],
  };
}

/** Multi-tool feature: several tools share one flag. */
function shared(
  group: FeatureGroup,
  key: string,
  kind: FeatureKind,
  tools: string[],
): FeatureDef {
  const envKey = key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
  return { group, key, envSuffix: `${GROUPS[group].envSuffix}_${envKey}`, kind, tools };
}

export const FEATURES: readonly FeatureDef[] = [
  // --- mail (IMAP/SMTP/ManageSieve) ---
  tool('mail', 'email_list_folders', 'read'),
  tool('mail', 'email_list', 'read'),
  tool('mail', 'email_read', 'read'),
  tool('mail', 'email_search', 'read'),
  tool('mail', 'email_filter_list', 'read'),
  tool('mail', 'email_send', 'write'),
  tool('mail', 'email_save_draft', 'write'),
  tool('mail', 'email_reply', 'write'),
  tool('mail', 'email_reply_all', 'write'),
  tool('mail', 'email_delete', 'write'),
  tool('mail', 'email_move', 'write'),
  tool('mail', 'email_flag', 'write'),
  tool('mail', 'email_mark_read', 'write'),
  tool('mail', 'email_mark_unread', 'write'),
  tool('mail', 'email_mark_spam', 'write'),
  tool('mail', 'email_archive', 'write'),
  tool('mail', 'email_create_folder', 'write'),
  tool('mail', 'email_delete_folder', 'write'),
  tool('mail', 'email_filter_create', 'write'),
  tool('mail', 'email_filter_update', 'write'),
  // --- calDav (CalDAV) ---
  tool('calDav', 'calendar_list', 'read'),
  tool('calDav', 'calendar_list_events', 'read'),
  tool('calDav', 'calendar_free_busy', 'read'),
  tool('calDav', 'calendar_create_event', 'write'),
  tool('calDav', 'calendar_update_event', 'write'),
  tool('calDav', 'calendar_delete_event', 'write'),
  shared('calDav', 'respondEvent', 'write', [
    'calendar_accept_event',
    'calendar_decline_event',
    'calendar_tentative_event',
  ]),
  // --- cardDav (CardDAV) ---
  tool('cardDav', 'contact_list', 'read'),
  tool('cardDav', 'contact_find', 'read'),
  tool('cardDav', 'contact_create', 'write'),
];

export const FEATURE_BY_TOOL: ReadonlyMap<string, FeatureDef> = new Map(
  FEATURES.flatMap((f) => f.tools.map((t) => [t, f])),
);

export function featuresOfGroup(group: FeatureGroup): FeatureDef[] {
  return FEATURES.filter((f) => f.group === group);
}

/** Default enabled state for a feature when unset everywhere. */
export function defaultEnabled(kind: FeatureKind): boolean {
  return kind === 'read';
}
