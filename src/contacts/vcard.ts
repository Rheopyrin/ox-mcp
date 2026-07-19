import { randomUUID } from 'node:crypto';

export interface ContactInput {
  /** Full display name. */
  name: string;
  emails?: string[];
  phones?: string[];
  organization?: string;
}

export interface ContactSummary {
  uid: string;
  name: string;
  emails: string[];
  phones: string[];
  organization?: string;
}

/** Build a minimal vCard 3.0 for a CardDAV PUT. */
export function buildVCard(input: ContactInput): { uid: string; vcard: string } {
  const uid = `${randomUUID()}@ox-mcp`;
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `UID:${uid}`,
    `FN:${escapeValue(input.name)}`,
    // structuredName already escapes each component; the `;` field separators
    // must stay literal, so it is NOT run through escapeValue again.
    `N:${structuredName(input.name)}`,
    ...(input.emails ?? []).map((e) => `EMAIL;TYPE=INTERNET:${escapeValue(e)}`),
    ...(input.phones ?? []).map((p) => `TEL:${escapeValue(p)}`),
    ...(input.organization ? [`ORG:${escapeValue(input.organization)}`] : []),
    'END:VCARD',
  ];
  return { uid, vcard: `${lines.join('\r\n')}\r\n` };
}

/** Parse the fields we surface from a vCard (handles folded lines). */
export function parseVCard(raw: string): ContactSummary {
  const unfolded = raw.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const contact: ContactSummary = { uid: '', name: '', emails: [], phones: [] };

  for (const line of lines) {
    const match = line.match(/^([^:;]+)((?:;[^:]*)?):(.*)$/);
    if (!match) continue;
    const prop = match[1].toUpperCase();
    const value = unescapeValue(match[3].trim());
    if (!value) continue;
    switch (prop) {
      case 'UID':
        contact.uid = value;
        break;
      case 'FN':
        contact.name = value;
        break;
      case 'EMAIL':
        contact.emails.push(value);
        break;
      case 'TEL':
        contact.phones.push(value);
        break;
      case 'ORG':
        contact.organization = value.replace(/;+$/, '');
        break;
    }
  }
  return contact;
}

/** "First [Middle …] Last" → vCard N field "Last;First Middle;;;" (per-component escaped). */
function structuredName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return `${escapeValue(parts[0])};;;;`;
  const last = escapeValue(parts[parts.length - 1]);
  const given = escapeValue(parts.slice(0, -1).join(' '));
  return `${last};${given};;;`;
}

function escapeValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function unescapeValue(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}
