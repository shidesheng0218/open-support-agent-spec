import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    testTimeout: 30000, // Real API calls may be slow
    hookTimeout: 10000,
  },
});
