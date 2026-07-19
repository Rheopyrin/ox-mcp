import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { SieveSession } from './sieve-client.js';

const TIMEOUT_MS = 15_000;

/**
 * Minimal ManageSieve (RFC 5804) session: plaintext connect on 4190,
 * STARTTLS upgrade, SASL PLAIN authenticate, then script commands.
 *
 * Network I/O only — protocol/rule logic lives in SieveClient and is unit
 * tested against a fake session.
 */
export class TcpSieveTransport implements SieveSession {
  private socket?: Socket;
  private buffer = '';
  private pending?: { resolve: (v: string) => void; reject: (e: Error) => void };

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly creds: { user: string; pass: string },
  ) {}

  async connect(): Promise<void> {
    const plain = netConnect({ host: this.host, port: this.port });
    this.attach(plain);
    await this.waitReady(plain);
    await this.readResponse(); // greeting + capabilities

    await this.command('STARTTLS');
    const secure = tlsConnect({ socket: plain, servername: this.host });
    this.attach(secure);
    await this.waitReady(secure, 'secureConnect');
    await this.readResponse(); // post-TLS capabilities

    const token = Buffer.from(`\0${this.creds.user}\0${this.creds.pass}`).toString('base64');
    await this.command(`AUTHENTICATE "PLAIN" "${token}"`);
  }

  async listScripts(): Promise<{ name: string; active: boolean }[]> {
    return parseListScripts(await this.command('LISTSCRIPTS'));
  }

  async getScript(name: string): Promise<string | undefined> {
    try {
      return extractScriptContent(await this.command(`GETSCRIPT "${name}"`));
    } catch {
      return undefined; // NO (nonexistent) — treat as absent
    }
  }

  async putScript(name: string, content: string): Promise<void> {
    const bytes = Buffer.byteLength(content, 'utf8');
    await this.command(`PUTSCRIPT "${name}" {${bytes}+}\r\n${content}`);
  }

  async setActive(name: string): Promise<void> {
    await this.command(`SETACTIVE "${name}"`);
  }

  async close(): Promise<void> {
    try {
      await this.command('LOGOUT');
    } catch {
      // Server may close the connection immediately; that's fine.
    }
    this.socket?.destroy();
    this.socket = undefined;
  }

  private attach(socket: Socket): void {
    // On the STARTTLS upgrade the previous (plain) socket is wrapped by the TLS
    // socket, so we must NOT strip its listeners (that would break TLS). Instead
    // every handler is bound to its own socket and no-ops once we've moved on,
    // and the buffer is reset so no pre-TLS bytes leak into the secure stream.
    this.socket = socket;
    this.buffer = '';
    socket.setTimeout(TIMEOUT_MS, () => {
      if (socket === this.socket) this.fail(new Error('ManageSieve timeout'));
    });
    socket.on('data', (chunk) => {
      if (socket !== this.socket) return;
      this.buffer += chunk.toString('utf8');
      this.tryResolve();
    });
    socket.on('error', (err) => {
      if (socket === this.socket) this.fail(err);
    });
  }

  private waitReady(socket: Socket, event: 'connect' | 'secureConnect' = 'connect'): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.once(event, resolve);
      socket.once('error', reject);
    });
  }

  private command(cmd: string): Promise<string> {
    if (!this.socket) return Promise.reject(new Error('ManageSieve: not connected'));
    this.socket.write(`${cmd}\r\n`);
    return this.readResponse();
  }

  private readResponse(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.tryResolve();
    });
  }

  /** Resolve once the buffer holds a complete response ending in OK/NO/BYE. */
  private tryResolve(): void {
    if (!this.pending) return;
    const end = findResponseEnd(this.buffer);
    if (end === -1) return;

    const response = this.buffer.slice(0, end);
    this.buffer = this.buffer.slice(end);
    const { resolve, reject } = this.pending;
    this.pending = undefined;

    if (/^(NO|BYE)\b/m.test(lastLine(response))) {
      reject(new Error(`ManageSieve error: ${lastLine(response)}`));
    } else {
      resolve(response);
    }
  }

  private fail(err: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(err);
    this.socket?.destroy();
  }
}

/** Parse a LISTSCRIPTS response into script names and their active flag. */
export function parseListScripts(res: string): { name: string; active: boolean }[] {
  const scripts: { name: string; active: boolean }[] = [];
  for (const line of res.split(/\r?\n/)) {
    const m = line.match(/^"((?:[^"\\]|\\.)*)"(\s+ACTIVE)?\s*$/i);
    if (m) scripts.push({ name: m[1].replace(/\\(.)/g, '$1'), active: Boolean(m[2]) });
  }
  return scripts;
}

/** Extract the script body from a GETSCRIPT response's `{n}` literal. */
export function extractScriptContent(res: string): string | undefined {
  const literal = res.match(/\{(\d+)\+?\}\r\n/);
  if (!literal) return undefined;
  const start = res.indexOf(literal[0]) + literal[0].length;
  return res.slice(start, start + Number(literal[1]));
}

/** Index just past the terminating OK/NO/BYE line, honoring {n} literals. */
export function findResponseEnd(buffer: string): number {
  let pos = 0;
  while (pos < buffer.length) {
    const nl = buffer.indexOf('\r\n', pos);
    if (nl === -1) return -1;
    const line = buffer.slice(pos, nl);
    const literal = line.match(/\{(\d+)\+?\}$/);
    if (literal) {
      pos = nl + 2 + Number(literal[1]);
      continue;
    }
    if (/^(OK|NO|BYE)\b/.test(line)) return nl + 2;
    pos = nl + 2;
  }
  return -1;
}

function lastLine(response: string): string {
  const lines = response.trimEnd().split(/\r?\n/);
  return lines[lines.length - 1] ?? '';
}
