import { describe, expect, it } from 'vitest';
import { buildVCard, parseVCard } from '../../src/contacts/vcard.js';

describe('buildVCard', () => {
  it('builds a minimal vCard 3.0 with UID, FN, N', () => {
    const { uid, vcard } = buildVCard({ name: 'Alice Doe' });
    expect(uid).toMatch(/@ox-mcp$/);
    expect(vcard).toContain('BEGIN:VCARD');
    expect(vcard).toContain('VERSION:3.0');
    expect(vcard).toContain('FN:Alice Doe');
    expect(vcard).toContain('N:Doe;Alice;;;');
    expect(vcard).toContain(`UID:${uid}`);
    expect(vcard).toContain('END:VCARD');
  });

  it('includes emails, phones, and organization', () => {
    const { vcard } = buildVCard({
      name: 'Bob',
      emails: ['bob@example.com', 'b@example.com'],
      phones: ['+123'],
      organization: 'ACME',
    });
    expect(vcard).toContain('EMAIL;TYPE=INTERNET:bob@example.com');
    expect(vcard).toContain('EMAIL;TYPE=INTERNET:b@example.com');
    expect(vcard).toContain('TEL:+123');
    expect(vcard).toContain('ORG:ACME');
    expect(vcard).toContain('N:Bob;;;;');
  });

  it('escapes commas in values', () => {
    const { vcard } = buildVCard({ name: 'Doe, Alice' });
    expect(vcard).toContain('FN:Doe\\, Alice');
  });

  it('escapes semicolons in FN but keeps N field separators literal', () => {
    const { vcard } = buildVCard({ name: 'Prince; Rogers' });
    // FN escapes the semicolon...
    expect(vcard).toContain('FN:Prince\\; Rogers');
    // ...while N still has exactly four structural ';' separators.
    const nLine = vcard.split(/\r?\n/).find((l) => l.startsWith('N:'))!;
    expect(nLine).toBe('N:Rogers;Prince\\;;;;');
  });
});

describe('parseVCard', () => {
  it('round-trips what buildVCard produced', () => {
    const { uid, vcard } = buildVCard({
      name: 'Alice Doe',
      emails: ['alice@example.com'],
      phones: ['+1'],
      organization: 'ACME',
    });
    expect(parseVCard(vcard)).toEqual({
      uid,
      name: 'Alice Doe',
      emails: ['alice@example.com'],
      phones: ['+1'],
      organization: 'ACME',
    });
  });

  it('handles folded lines and parameters', () => {
    const raw = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'UID:u1',
      'FN:Very Long',
      ' Name',
      'EMAIL;TYPE=WORK;PREF=1:long@example.com',
      'END:VCARD',
    ].join('\r\n');
    const parsed = parseVCard(raw);
    expect(parsed.name).toBe('Very LongName');
    expect(parsed.emails).toEqual(['long@example.com']);
  });
});
