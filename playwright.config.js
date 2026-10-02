// @ts-check
const path = require('path');
const { defineConfig } = require('@playwright/test');

// Runs the real server.js against a disposable SQLite database — never the
// real dev/production data/ directory — so the suite is safe to run
// repeatedly and never shows or modifies real planning data.
//
// Each run gets its own directory (rather than always ".tmp-data" wiped on
// every run) so globalSetup never deletes a database the webServer might
// already be reading/writing — that race caused intermittent login
// timeouts when the two happened to overlap. globalSetup instead prunes
// directories left over from previous runs.
const TEST_DATA_DIR = path.join(__dirname, 'tests', '.tmp-data', 'run-' + Date.now());
process.env.PLANNING_TEST_DATA_DIR = TEST_DATA_DIR;
const TEST_PORT = 4321;

module.exports = defineConfig({
  testDir: './tests/e2e',
  globalSetup: require.resolve('./tests/global-setup.js'),
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${TEST_PORT}`,
    headless: true,
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `node server.js`,
    url: `http://localhost:${TEST_PORT}/`,
    timeout: 15000,
    reuseExistingServer: false,
    env: {
      PORT: String(TEST_PORT),
      DATA_DIR: TEST_DATA_DIR,
      SEED_ADMIN_USER: 'test',
      SEED_ADMIN_PASSWORD: 'test1234',
    },
  },
});
