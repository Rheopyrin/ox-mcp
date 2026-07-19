import type { ResolvedSection } from '../config/config-resolver.js';
import type { AuthProvider } from '../auth/auth-provider.js';
import { buildFreeBusyRequest, parseFreeBusy, type BusyPeriod } from './ical.js';

export type FetchFn = typeof fetch;

export interface AttendeeFreeBusy {
  attendee: string;
  status: string;
  busy: BusyPeriod[];
}

/**
 * Free/busy lookup via the CalDAV scheduling outbox (RFC 6638 §5). Discovers
 * the caller's `schedule-outbox-URL`, POSTs a VFREEBUSY REQUEST listing the
 * attendees, and parses the per-attendee schedule-response. Reveals only
 * busy/free windows, not event details — and needs no calendar sharing.
 */
export class FreeBusyClient {
  constructor(
    private readonly section: ResolvedSection,
    private readonly authProvider: AuthProvider,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async getFreeBusy(attendees: string[], start: string, end: string): Promise<AttendeeFreeBusy[]> {
    if (attendees.length === 0) return [];
    const header = await this.authProvider.getDavAuthHeader();
    const outbox = await this.discoverOutbox(header);

    const body = buildFreeBusyRequest({
      organizer: this.section.auth.user,
      attendees,
      start,
      end,
    });
    const res = await this.fetchFn(outbox, {
      method: 'POST',
      headers: {
        Authorization: header,
        'Content-Type': 'text/calendar; charset=utf-8',
        Depth: '0',
      },
      body,
    });
    if (!res.ok) {
      throw new Error(`Free/busy request failed (${res.status}).`);
    }
    return parseScheduleResponse(await res.text());
  }

  private get origin(): string {
    return `https://${this.section.server}`;
  }

  private async discoverOutbox(header: string): Promise<string> {
    const principal = await this.propfindHref(
      header,
      this.origin,
      `<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`,
      'current-user-principal',
    );
    if (!principal) {
      throw new Error('Could not discover the current-user-principal for free/busy.');
    }
    const outbox = await this.propfindHref(
      header,
      this.resolve(principal),
      `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:schedule-outbox-URL/></d:prop></d:propfind>`,
      'schedule-outbox-URL',
    );
    if (!outbox) {
      throw new Error(
        'This server does not advertise a CalDAV scheduling outbox (schedule-outbox-URL); free/busy is unavailable.',
      );
    }
    return this.resolve(outbox);
  }

  private async propfindHref(
    header: string,
    url: string,
    body: string,
    containerTag: string,
  ): Promise<string | undefined> {
    const res = await this.fetchFn(url, {
      method: 'PROPFIND',
      headers: {
        Authorization: header,
        'Content-Type': 'application/xml; charset=utf-8',
        Depth: '0',
      },
      body,
    });
    if (!res.ok) return undefined;
    const xml = await res.text();
    const container = extractTag(xml, containerTag);
    return extractTag(container ?? xml, 'href')?.trim();
  }

  private resolve(href: string): string {
    if (/^https?:\/\//i.test(href)) return href;
    if (href.startsWith('/')) return `${this.origin}${href}`;
    return `${this.origin}/${href}`;
  }
}

/** Parse a CALDAV:schedule-response into per-attendee busy periods. */
export function parseScheduleResponse(xml: string): AttendeeFreeBusy[] {
  const results: AttendeeFreeBusy[] = [];
  const responseRe = /<[^>]*\bresponse\b[^>]*>([\s\S]*?)<\/[^>]*\bresponse\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = responseRe.exec(xml)) !== null) {
    const block = match[1];
    const recipient = extractTag(extractTag(block, 'recipient') ?? '', 'href')?.trim();
    if (!recipient) continue;
    const status = extractTag(block, 'request-status')?.trim() ?? '';
    const calData = extractTag(block, 'calendar-data');
    const busy = calData ? parseFreeBusy(unwrapXmlText(calData).trim()) : [];
    results.push({ attendee: recipient.replace(/^mailto:/i, ''), status, busy });
  }
  return results;
}

function extractTag(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<[^>]*\\b${tag}\\b[^>]*>([\\s\\S]*?)<\\/[^>]*\\b${tag}\\b[^>]*>`, 'i');
  return xml.match(re)?.[1];
}

/**
 * calendar-data arrives either CDATA-wrapped (Open-Xchange) or entity-encoded.
 * CDATA content is literal — never entity-decode it.
 */
function unwrapXmlText(value: string): string {
  const cdata = value.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return cdata ? cdata[1] : decodeXml(value);
}

function decodeXml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
