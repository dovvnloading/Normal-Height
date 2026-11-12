import { defineConfig, devices } from '@playwright/test';

// Hardware benchmark: no forced SwiftShader or software fallback by default.
// The regular playwright.config.ts intentionally uses SwiftShader for portable CI.
const software = process.env.MESH_BENCH_SOFTWARE === '1';
const headless = process.env.MESH_BENCH_HEADLESS === '1';
const chrome = process.env.MESH_BENCH_CHROME === '1';

export default defineConfig({
  testDir: './tests/perf',
  testMatch: 'mesh-perf.spec.ts',
  outputDir: './mesh-benchmark-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 90_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: 'mesh-benchmark-report', open: 'never' }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4173',
    channel: chrome ? 'chrome' : undefined,
    headless,
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    locale: 'en-US',
    launchOptions: {
      args: software
        ? ['--use-gl=angle', '--use-angle=swiftshader',
           '--enable-unsafe-swiftshader', '--disable-dev-shm-usage']
        : ['--ignore-gpu-blocklist'],
    },
    // Each case captures actual WebGL buffers; opt in to full motion videos.
    video: process.env.MESH_BENCH_VIDEO === '1' ? 'on' : 'retain-on-failure',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 25_000,
    navigationTimeout: 40_000,
  },
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
