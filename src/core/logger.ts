import { injectable } from 'inversify';

/**
 * Minimal leveled logger.
 *
 * IMPORTANT: this server speaks the MCP protocol over **stdout** (stdio
 * transport). All human-readable logging MUST go to **stderr** so it never
 * corrupts the JSON-RPC stream on stdout.
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

@injectable()
export class ConsoleLogger implements Logger {
  private readonly threshold: number;

  constructor(level: LogLevel = resolveLevelFromEnv()) {
    this.threshold = LEVEL_WEIGHT[level];
  }

  debug(message: string, ...args: unknown[]): void {
    this.write('debug', message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.write('info', message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.write('warn', message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.write('error', message, args);
  }

  private write(level: Exclude<LogLevel, 'silent'>, message: string, args: unknown[]): void {
    if (LEVEL_WEIGHT[level] < this.threshold) return;
    const line = `[ox-mcp] ${level.toUpperCase()} ${message}`;
    // Always stderr — see class doc.
    if (args.length > 0) {
      process.stderr.write(`${line} ${args.map(safeStringify).join(' ')}\n`);
    } else {
      process.stderr.write(`${line}\n`);
    }
  }
}

function resolveLevelFromEnv(): LogLevel {
  const raw = process.env.OX_MCP_LOG_LEVEL?.toLowerCase();
  if (raw && raw in LEVEL_WEIGHT) return raw as LogLevel;
  return 'info';
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
