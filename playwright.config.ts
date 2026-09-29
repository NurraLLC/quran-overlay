import { defineConfig } from '@playwright/test';

const port = process.env.QO_UI_TEST_PORT || '4399';

// Browser flows against the real server + built frontend, using the installed Edge (no browser download).
export default defineConfig({
  testDir: 'tests/ui',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { channel: 'msedge', baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: 'npx tsx src/server/main.ts',
    url: `http://127.0.0.1:${port}/api/owner/status`,
    reuseExistingServer: false,
    timeout: 60_000,
    // A placeholder speech key: .env never overrides it, so browser tests can never use the real one
    // (the silence-skipper test stands in for the provider).
    env: { PORT: port, QO_OWNER_TOKEN: 'ui-test-owner-capability-0001', TRACKER_MODE: 'deterministic', SONIOX_API_KEY: 'ui-test-not-a-real-key', OPENROUTER_API_KEY: '', TYPESAFE_API_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '' },
  },
});
