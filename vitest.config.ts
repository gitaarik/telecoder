import { defineConfig } from 'vitest/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Modules read and write ~/.claudegram as they load, so the whole suite gets a
// scratch home. On the real one a run reads the developer's settings and leaves
// copies of them behind under the test bot's id.
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'telecoder-test-home-'));
process.on('exit', () => fs.rmSync(testHome, { recursive: true, force: true }));

export default defineConfig({
  test: {
    // config.ts validates these at import time and process.exit(1)s if missing.
    // Provide harmless dummies so modules that transitively import config load.
    env: {
      HOME: testHome,
      // Point at a non-existent env file so tests are isolated from the dev .env.
      TELECODER_ENV_PATH: '/nonexistent/telecoder-test.env',
      TELEGRAM_BOT_TOKEN: '123456789:TEST_TOKEN',
      ALLOWED_USER_IDS: '1,2,3',
      ALLOWED_GROUP_IDS: '-1009990001',
      WORKSPACE_DIR: '/tmp/telecoder-test-workspace',
      // Pin the default explicitly. Running the suite from inside a TeleCoder
      // worker otherwise inherits that worker's BOT_NAME (e.g. "TeleCoder 6"),
      // and the botname tests assert against the default.
      BOT_NAME: 'TeleCoder',
    },
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html'],
    },
  },
});
