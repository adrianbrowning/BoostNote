import { defineConfig } from '@playwright/test'

import type { ThemeOption } from './fixtures.ts'

/**
 * Screenshots for the user guide (`site/`), run by hand: `pnpm docs:shots`. Each spec drives the
 * real Electron app on a temp copy of the demo vault and saves PNGs into `site/src/assets/shots/`,
 * once per theme. Not part of `pnpm test:e2e` (its `testDir` is tests/e2e).
 */
export default defineConfig<ThemeOption>({
  testDir: '.',
  testMatch: '**/*.shot.ts',
  globalSetup: '../e2e/global-setup.ts',
  workers: 4,
  fullyParallel: true,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: '../../test-results/docs',
  projects: [
    { name: 'light', use: { theme: 'light' } },
    { name: 'dark', use: { theme: 'dark' } },
  ],
})
