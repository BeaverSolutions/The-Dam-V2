import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    root: path.resolve(__dirname, 'server'),
    testTimeout: 30000,
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      include: ['services/**', 'utils/**'],
    },
  },
});
