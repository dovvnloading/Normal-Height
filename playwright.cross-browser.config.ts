import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/** Portable data-authoring workflows. GPU fidelity remains in the dedicated
 * Chromium/Metal qualification; these gates exercise native storage, workers,
 * dialogs, file import/export and keyboard interaction on the other engines. */
export default defineConfig({
  ...base,
  outputDir: './test-results-cross-browser',
  testMatch: [
    '**/project-library.spec.ts',
    '**/graph-reuse.spec.ts',
    '**/world-material-export.spec.ts',
  ],
  retries: 0,
  use: {
    ...base.use,
    video: 'off',
    channel: undefined,
    launchOptions: {},
  },
  projects: [
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 1000 } },
    },
  ],
});
