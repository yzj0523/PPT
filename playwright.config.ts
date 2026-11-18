import { defineConfig } from '@playwright/test';

const development = new URL('http://127.0.0.1:5211');
const production = new URL('http://127.0.0.1:5212');

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  use: { browserName: 'chromium' },
  projects: [
    {
      name: 'development',
      testIgnore: '**/production.spec.ts',
      use: { baseURL: development.origin },
    },
    {
      name: 'production',
      testMatch: '**/production.spec.ts',
      use: { baseURL: production.origin },
    },
  ],
  webServer: [
    { command: 'node tests/model-stub.ts', url: 'http://127.0.0.1:5213/health' },
    {
      command: 'npm run dev',
      url: `${development.origin}/api/health`,
      env: { WORKBENCH_PORT: development.port, WORKBENCH_DB_PATH: ':memory:',
        AI_BASE_URL: 'http://127.0.0.1:5213/v1', AI_MODEL: 'test-model', AI_API_KEY: 'local-fixture' },
    },
    {
      command: 'npm run build && npm start',
      url: `${production.origin}/api/health`,
      env: { WORKBENCH_PORT: production.port, WORKBENCH_DB_PATH: ':memory:', AI_BASE_URL: '', AI_MODEL: '', AI_API_KEY: '' },
    },
  ],
});
