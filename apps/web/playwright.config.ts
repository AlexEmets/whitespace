import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4300',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm exec next dev -p 4300',
    url: 'http://127.0.0.1:4300',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      // Same-origin path prefix on the dev server itself, so tests/e2e/mockBackend.ts
      // can intercept it with page.route without any CORS configuration. The WS URL is
      // never actually reachable in tests — the app's REST-poll fallback (see
      // src/hooks/useLiveResource.ts) is what E2E exercises; see docs/decisions/
      // phase-5-frontend.md for why WS itself isn't covered by Playwright here.
      NEXT_PUBLIC_API_BASE_URL: 'http://127.0.0.1:4300/__api',
      NEXT_PUBLIC_WS_URL: 'ws://127.0.0.1:4300/__ws',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
