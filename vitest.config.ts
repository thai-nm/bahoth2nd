import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
  resolve: {
    alias: {
      '@bahoth/shared': new URL('./packages/shared/src/index.ts', import.meta.url)
        .pathname,
      '@bahoth/content': new URL('./packages/content/src/index.ts', import.meta.url)
        .pathname,
      '@bahoth/engine': new URL('./packages/engine/src/index.ts', import.meta.url)
        .pathname,
    },
  },
});
