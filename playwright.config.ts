import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { config } from 'dotenv';

// Load test environment variables
config({ path: '.env.test' });

/**
 * Playwright configuration for arr-dashboard E2E tests.
 * See https://playwright.dev/docs/test-configuration.
 */

const authFile = path.join(__dirname, '.playwright-auth/user.json');

export default defineConfig({
  testDir: './e2e',
  /* Run tests in files in parallel - limited workers to prevent session race conditions */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 1,
  /* Force single worker to ensure auth state reliability
   * Parallel execution causes race conditions with session-based auth */
  workers: 1,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [
    ['html'],
    ['list'],
  ],
  /* Global timeout for each test - increased for slower page loads */
  timeout: 60000,
  /* Shared settings for all the projects below. */
  use: {
    /* Base URL to use in actions like `await page.goto('')`. */
    baseURL: 'http://localhost:3000',

    /* Collect trace when retrying the failed test. */
    trace: 'on-first-retry',

    /* Take screenshot on failure */
    screenshot: 'only-on-failure',

    /* Video on failure */
    video: 'retain-on-failure',
  },

  /* Configure projects for major browsers */
  projects: [
    // Setup project - runs authentication
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
    },

    // Main test project - depends on setup
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Use saved auth state
        storageState: authFile,
      },
      dependencies: ['setup'],
    },

    // Firefox (optional - can be enabled for cross-browser testing)
    // {
    //   name: 'firefox',
    //   use: {
    //     ...devices['Desktop Firefox'],
    //     storageState: authFile,
    //   },
    //   dependencies: ['setup'],
    // },
  ],

  /* Expect configuration */
  expect: {
    /* Maximum time to wait for assertions */
    timeout: 10000,
  },
});
