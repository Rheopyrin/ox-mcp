import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildContainer } from '../../src/container.js';
import { TYPES } from '../../src/core/types.js';
import type { OxMcpServer } from '../../src/server/mcp-server.js';

let home: string;
let client: Client;
const saved: Record<string, string | undefined> = {};

const ENV = {
  HOME: '',
  USERPROFILE: '',
  OX_MCP_MAIL_SERVER: 'mail.example.com',
  OX_MCP_MAIL_USER: 'me@example.com',
  OX_MCP_MAIL_APP_PASSWORD: 'secret-pw',
  OX_MCP_CALDAV_SERVER: 'dav.example.com',
  OX_MCP_CALDAV_USER: 'me@example.com',
  OX_MCP_CALDAV_APP_PASSWORD: 'caldav-pw',
  OX_MCP_CARDDAV_SERVER: 'dav.example.com',
  OX_MCP_CARDDAV_USER: 'me@example.com',
  OX_MCP_CARDDAV_APP_PASSWORD: 'carddav-pw',
  OX_MCP_ENABLE_EMAIL_SEND: 'true',
  OX_MCP_ENABLE_EMAIL_SEARCH: 'false',
};

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'ox-mcp-int-'));
  ENV.HOME = home;
  ENV.USERPROFILE = home;
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }

  const container = await buildContainer(process.env);
  const oxServer = container.get<OxMcpServer>(TYPES.McpServer);
  const mcp = oxServer.create();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client?.close();
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(home, { recursive: true, force: true });
});

describe('MCP server (in-memory)', () => {
  it('advertises reads + enabled write, hides disabled read and disabled writes', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain('list_servers');
    expect(names).toContain('email_list');
    expect(names).toContain('calendar_free_busy');
    expect(names).toContain('contact_list');
    expect(names).toContain('email_send'); // enabled via env
    expect(names).not.toContain('email_search'); // disabled via env
    expect(names).not.toContain('calendar_delete_event'); // write, default off
    expect(names).not.toContain('calendar_accept_event'); // shared RSVP feature, default off
  });

  it('runs list_servers and never leaks secrets', async () => {
    const res = await client.callTool({ name: 'list_servers', arguments: {} });
    const body = (res.content as { type: string; text: string }[])[0].text;
    expect(body).toContain('me@example.com');
    expect(body).toContain('"authType": "basic"');
    expect(body).not.toContain('secret-pw');
  });

  it('exposes email_send with a non-read-only annotation', async () => {
    const { tools } = await client.listTools();
    const send = tools.find((t) => t.name === 'email_send');
    expect(send?.annotations?.readOnlyHint).toBe(false);
  });
});
