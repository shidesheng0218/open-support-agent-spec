import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    testTimeout: 60000, // Stress tests may take longer
    hookTimeout: 30000,
  },
});
