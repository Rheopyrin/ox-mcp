# ox-mcp

An MCP server for **Open-Xchange and standards-based mail platforms** — read & search email, send & reply, manage server-side filters, calendar events and invitations, contacts, and other people's availability (free/busy), across one or many accounts.

It speaks standard **IMAP + SMTP + ManageSieve + CalDAV + CardDAV** with **RFC 6638** free/busy, so it works with any Open-Xchange deployment or standards-compliant host. Authenticate with your **email + app password** (the same credential DAVx5 uses) or OAuth2/OIDC.

> No affiliation with Open-Xchange.

## Install / run

```bash
npx -y @rheopyrin/ox-mcp
# or with a custom config location:
npx -y @rheopyrin/ox-mcp --config /path/to/config.json
```

MCP client config (Claude Desktop / Claude Code):

```jsonc
{
  "mcpServers": {
    "ox": {
      "command": "npx",
      "args": ["-y", "@rheopyrin/ox-mcp"],
      "env": {
        "OX_MCP_MAIL_SERVER": "mail.example.com",
        "OX_MCP_MAIL_USER": "you@yourdomain.com",
        "OX_MCP_MAIL_APP_PASSWORD": "xxxx-xxxx-xxxx-xxxx",
        "OX_MCP_CALDAV_SERVER": "dav.example.com",
        "OX_MCP_CALDAV_USER": "you@yourdomain.com",
        "OX_MCP_CALDAV_APP_PASSWORD": "yyyy-yyyy-yyyy-yyyy"
      }
    }
  }
}
```

On first run (without `--config`) it creates `~/.ox-mcp/config.json` (permissions `0600`) with every feature flag listed — **reads enabled, writes disabled** — and empty hosts for you to fill in.

### `--config`

`--config <file>` (or env `OX_MCP_CONFIG`; the flag wins) loads an explicit config file instead of `~/.ox-mcp/config.json`. The file **must exist** — nothing is auto-created when the override is used.

## Tools

Tools are grouped by protocol domain. A group's tools appear only when enabled, and the group's server host must be configured (see *Validation*).

| Group | Read (enabled by default) | Write (disabled by default) |
|---|---|---|
| `email_*` (IMAP/SMTP/Sieve — `mail` section) | `email_list_folders`, `email_list`, `email_read`, `email_search`, `email_filter_list` | `email_send`, `email_save_draft`, `email_reply`, `email_reply_all`, `email_delete`, `email_move`, `email_flag`, `email_mark_read`, `email_mark_unread`, `email_mark_spam`, `email_archive`, `email_create_folder`, `email_delete_folder`, `email_filter_create`, `email_filter_update` |
| `calendar_*` (CalDAV — `calDav` section) | `calendar_list`, `calendar_list_events`, `calendar_free_busy` | `calendar_create_event`, `calendar_update_event`, `calendar_delete_event`, `calendar_accept_event`, `calendar_decline_event`, `calendar_tentative_event` |
| `contact_*` (CardDAV — `cardDav` section) | `contact_list`, `contact_find` | `contact_create` |
| meta | `list_servers` (always on) | — |

- Every tool (except `list_servers`) accepts an optional `server` argument to target a specific account. A tool is **hidden** from the tool list unless its flag is enabled for at least one account.
- `email_search` searches **all folders** by default; pass `folder` to narrow it. On the `ox-api` transport, `body`/`text` match only the subject and addresses of recent messages — use `transport: "imap"` for true full-text search.
- `email_mark_spam` / `email_archive` find the Junk/Archive folder via IMAP special-use attributes, with name-based fallbacks.
- `email_reply` / `email_reply_all` preserve threading (`In-Reply-To`/`References`) and exclude your own address from reply-all recipients.
- The three RSVP tools (`calendar_accept_event` / `calendar_decline_event` / `calendar_tentative_event`) share **one** feature flag: `respondEvent` (calDav section). They rewrite your `PARTSTAT` on the invitation; the server notifies the organizer.
- `contact_find` searches contacts **server-side** (CardDAV `addressbook-query`, RFC 6352) with automatic fallback to client-side filtering; `fields` narrows the match to `name`/`email`/`phone`/`org` (default name + email). Handy for resolving a name to an email before `calendar_free_busy`. `contact_list` is plain enumeration.

### Mail filters

`email_filter_create` / `email_filter_update` manage **server-side sieve filters** over ManageSieve (port 4190, STARTTLS; requires basic/app-password auth). Rules support conditions on `from`/`to`/`subject`/any header (AND or OR) and actions `fileinto` (move to folder), `discard`, `markRead`, `redirect`.

> Backend depends on `mail.transport`: with **ox-api** (default), filters go through the OX `mailfilter/v2` module and operate on the account's real webmail rules (rules with tests/actions beyond this model are listed read-only as `other`). With **imap**, ox-mcp manages its own sieve script over ManageSieve (port 4190) and **activates it** — filters from other scripts become inactive while it is active.

## Configuration: per-protocol sections

Each account is made of up to three **self-contained sections** — `mail`, `calDav`, `cardDav` — each with its own `server`, `auth` (incl. its own login `user`), and `features`. This matches servers (like Open-Xchange) that scope app passwords per protocol: your Mail password, CalDAV password, and CardDAV password can all differ.

```jsonc
{
  "defaultServer": "default",
  "timeoutSeconds": 300,                                     // optional; request timeout, default 300
  "servers": {
    "default": {
      "mail": {
        "server": "webmail.example.com",                    // OX HTTP API host (default transport)
        "transport": "ox-api",                              // optional; "imap" for direct IMAP/SMTP
        "imap": { "host": "imap.example.com", "port": 993 }, // optional overrides
        "smtp": { "host": "smtp.example.com", "port": 587, "secure": false }, // secure optional; 993/465 = TLS, else STARTTLS
        "auth": { "type": "basic", "user": "me@example.com", "appPassword": "mail-scoped-pw" },
        "features": { "search": true, "send": false /* per-tool flags */ }
      },
      "calDav": {
        "server": "dav.example.com",
        "auth": { "type": "basic", "user": "me@example.com", "appPassword": "caldav-scoped-pw" },
        "features": { "respondEvent": false /* … */ }
      },
      "cardDav": {
        "server": "dav.example.com",
        "auth": { "type": "basic", "user": "me@example.com", "appPassword": "carddav-scoped-pw" }
      }
    }
  }
}
```

- **A section you don't configure = its tools are disabled.** A calDav-only config is perfectly valid.
- **`mail.transport` is optional and defaults to `"ox-api"`** — the **Open-Xchange HTTP API** (the webmail backend, `https://<server>/appsuite/api`). OX deployments validate app passwords at this middleware, so it works even where raw IMAP rejects them; `server` is the webmail host. Filter tools use the OX `mailfilter/v2` module — they list and edit the account's **actual webmail rules**. Caveat: search matches subject/addresses (not full bodies).
- Set **`transport: "imap"`** for direct IMAP/SMTP against generic (non-OX) mail hosts — then `server` is the mail host, with optional split `imap`/`smtp` endpoints.
- `enabled: false` on a section is a config master switch for all its tools.
- There is **no global features block** — flags live only inside sections (env vars remain global).

## Feature flags

Resolution precedence — **env always beats config**, first defined wins:

1. per-account env, tool — `OX_MCP_<ID>_ENABLE_EMAIL_SEND`
2. per-account env, group — `OX_MCP_<ID>_ENABLE_MAIL`
3. global env, tool — `OX_MCP_ENABLE_EMAIL_SEND`
4. global env, group — `OX_MCP_ENABLE_MAIL` / `_CALDAV` / `_CARDDAV`
5. section config, tool — `servers.<id>.mail.features.send`
6. section config, master — `servers.<id>.mail.enabled`
7. default — `true` for reads, `false` for writes

```bash
# enable sending on all accounts
OX_MCP_ENABLE_EMAIL_SEND=true
# turn off the whole calendar section
OX_MCP_ENABLE_CALDAV=false
# enable event creation only on the "work" account
OX_MCP_WORK_ENABLE_CALENDAR_CREATE_EVENT=true
# enable all three RSVP tools at once
OX_MCP_ENABLE_CALENDAR_RESPOND_EVENT=true
```

Booleans accept `true/1/yes/on` and `false/0/no/off`.

## Connection & credentials (env)

Every section field is settable via env: `OX_MCP_[ID_]<SECTION>_<FIELD>` with SECTION ∈ `MAIL | CALDAV | CARDDAV`. The default account uses the non-indexed form.

| Env var | Meaning |
|---|---|
| `OX_MCP_MAIL_SERVER` / `OX_MCP_CALDAV_SERVER` / `OX_MCP_CARDDAV_SERVER` | section host |
| `OX_MCP_MAIL_USER` / `OX_MCP_CALDAV_USER` / `OX_MCP_CARDDAV_USER` | section login user |
| `OX_MCP_MAIL_APP_PASSWORD` / `OX_MCP_CALDAV_APP_PASSWORD` / … | section app password (basic auth) |
| `OX_MCP_MAIL_IMAP_HOST` / `_IMAP_PORT` / `_SMTP_HOST` / `_SMTP_PORT` | mail transport overrides (Gmail-style split hosts) |
| `OX_MCP_MAIL_IMAP_SECURE` / `_SMTP_SECURE` | force TLS (`true`) or STARTTLS (`false`) on a non-standard port |
| `OX_MCP_MAIL_AUTH_TYPE`, `_CLIENT_ID`, `_REFRESH_TOKEN`, … | per-section OAuth/OIDC fields |
| `OX_MCP_TIMEOUT_SECONDS` | request timeout for all HTTP/IMAP/SMTP operations (default 300) |

Default ports: IMAP 993, SMTP 465, DAV 443, ManageSieve 4190. TLS mode derives from the port (993/465 implicit TLS; 143/587 STARTTLS) unless `secure` is set explicitly.

### Validation

Configuration is validated strictly at startup: every **present** section with enabled tools must have a server (or split imap/smtp hosts for mail) and a login user, or the server exits with an error naming the exact field. Accounts with zero sections error too. Absent sections are simply disabled — no error.

## Authentication types

`basic` (app password) is the default. Other Open-Xchange-aligned mechanisms are supported **per section** via `auth.type` / `OX_MCP_[ID_]<SECTION>_AUTH_TYPE`:

| Type | Extra fields (env: `OX_MCP_[ID_]<SECTION>_…`) |
|---|---|
| `basic` | `APP_PASSWORD` |
| `xoauth2` | `ACCESS_TOKEN` |
| `oauth2-refresh` | `CLIENT_ID`, `CLIENT_SECRET`, `REFRESH_TOKEN`, `TOKEN_URL`, `SCOPE` |
| `oauth2-password` | `CLIENT_ID`, `CLIENT_SECRET`, `PASSWORD`, `TOKEN_URL`, `SCOPE` |
| `oidc` | `ISSUER`, `CLIENT_ID`, `CLIENT_SECRET`, `REFRESH_TOKEN` or `PASSWORD`, `SCOPE` |

Tokens are cached and refreshed automatically. Note: mail filters (ManageSieve) require `basic` auth.

## Multiple accounts

```bash
OX_MCP_ACCOUNTS=work,personal
OX_MCP_WORK_MAIL_SERVER=mail.work.com
OX_MCP_WORK_MAIL_USER=me@work.com
OX_MCP_WORK_MAIL_APP_PASSWORD=...
OX_MCP_PERSONAL_CALDAV_SERVER=dav.personal.com
OX_MCP_PERSONAL_CALDAV_USER=me@personal.com
OX_MCP_PERSONAL_CALDAV_APP_PASSWORD=...
OX_MCP_DEFAULT_SERVER=work
```

Or define them in `~/.ox-mcp/config.json` under `servers` (keyed by id). `list_servers` shows what's configured (never secrets); env values override config field-by-field. Feature flags can differ per account (e.g. sending enabled only on `work`).

## Free/busy caveat

`calendar_free_busy` returns **availability windows only** (busy/free), via the CalDAV scheduling outbox — no calendar sharing needed. It does **not** reveal event details, and requires the server to advertise a `schedule-outbox-URL`. To read a colleague's **full** calendar, they must share it with your account; shared calendars then appear in `calendar_list` / `calendar_list_events`.

## Docker

```bash
docker build -t ox-mcp .
docker run -i --rm \
  -e OX_MCP_MAIL_SERVER=mail.example.com \
  -e OX_MCP_MAIL_USER=you@yourdomain.com \
  -e OX_MCP_MAIL_APP_PASSWORD=xxxx \
  ox-mcp
```

## Development

```bash
npm install
npm run dev          # run from source
npm test             # vitest
npm run test:coverage
npm run build        # bundle to dist/ (tsup)
```

## License

MIT
