import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.BASE_URL;
if (!baseURL) throw new Error('BASE_URL is not set. Run the suite with e2e/run.sh, which starts the image and sets it.');
const ci = !!process.env.CI;

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  forbidOnly: ci,
  // One retry, only to tell a flaky test from a broken one: failOnFlakyTests still fails the run
  // when a test passes only on its retry, and the retry records the trace.
  retries: ci ? 1 : 0,
  failOnFlakyTests: ci,
  workers: ci ? 2 : undefined,
  reporter: ci ? [['list'], ['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    // A fixed locale and time zone, so dates render the same on every machine.
    locale: 'en-US',
    colorScheme: 'light',
    timezoneId: 'Asia/Qatar',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        // Production serves HTTPS; the suite reaches the image over plain HTTP on a container name.
        // Without this, Chromium logs that it ignored the Cross-Origin-Opener-Policy header, and the
        // fixtures fail any test that logs a console error.
        launchOptions: { args: [`--unsafely-treat-insecure-origin-as-secure=${new URL(baseURL).origin}`] },
      },
    },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } } },
  ],
});
