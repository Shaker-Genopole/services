import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@zk-sla/shared-configs': src('shared-configs'),
      '@zk-sla/shared-connections': src('shared-connections'),
      '@zk-sla/shared-entities': src('shared-entities'),
      '@zk-sla/shared-utils': src('shared-utils'),
      '@zk-sla/datasets': src('datasets'),
      '@zk-sla/sui-client': src('sui-client'),
      // prover-worker sources are imported by the gateway integration test
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 900_000,
    pool: 'forks',
  },
});
