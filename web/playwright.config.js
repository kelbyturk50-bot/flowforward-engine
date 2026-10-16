import { defineConfig } from '@playwright/test';

const chrome = process.env.PLAYWRIGHT_CHROME || '/usr/local/bin/google-chrome';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'http://localhost:5173',
    launchOptions: {
      executablePath: chrome,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
  },
  webServer: {
    command: 'npm run dev -- --host localhost --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
