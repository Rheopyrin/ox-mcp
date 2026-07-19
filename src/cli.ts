import type { Env } from './config/env.js';

/** Parse `--config <path>` / `--config=<path>`; falls back to OX_MCP_CONFIG. */
export function parseConfigPath(argv: string[], env: Env = process.env): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--config requires a file path argument');
      }
      return value;
    }
    if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      if (!value) throw new Error('--config requires a file path argument');
      return value;
    }
  }
  return env.OX_MCP_CONFIG?.trim() || undefined;
}
