import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // config.ts validates these at import time and process.exit(1)s if missing.
    // Provide harmless dummies so modules that transitively import config load.
    env: {
      // Point at a non-existent env file so tests are isolated from the dev .env.
      CLAUDEGRAM_ENV_PATH: '/nonexistent/telecoder-test.env',
      TELEGRAM_BOT_TOKEN: '123456789:TEST_TOKEN',
      ALLOWED_USER_IDS: '1,2,3',
      ALLOWED_GROUP_IDS: '-1009990001',
      WORKSPACE_DIR: '/tmp/telecoder-test-workspace',
      // Force the SSRF guard on regardless of the developer's shell/.env.
      ALLOW_PRIVATE_NETWORK_URLS: 'false',
    },
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html'],
    },
  },
});
