import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  shims: false,
  // Preserve the shebang so `npx -y @rheopyrin/ox-mcp` runs directly.
  banner: {
    js: '#!/usr/bin/env node',
  },
});
