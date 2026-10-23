import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const core = (p: string) => fileURLToPath(new URL(`./packages/core/src/${p}`, import.meta.url));

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    // Tests run against core sources (no build step needed).
    alias: [
      { find: /^@pa\/core\/contract$/, replacement: core('contract/index.ts') },
      { find: /^@pa\/core\/harness$/, replacement: core('harness/index.ts') },
      { find: /^@pa\/key-helper$/, replacement: fileURLToPath(new URL('./packages/key-helper/src/index.ts', import.meta.url)) },
      { find: /^@pa\/core$/, replacement: core('index.ts') },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'apps/*/test/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**', 'test/live/**'],
  },
});
