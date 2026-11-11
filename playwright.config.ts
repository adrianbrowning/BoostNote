import { mkdirSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

// Screenshots of the smoke run land here (referenced by the phase 6 notes).
mkdirSync('/tmp/boost-phase6', { recursive: true })

/**
 * End-to-end smoke tests: the real Electron app from source (`_electron`). Every test launches its
 * own app on its own temp vault, profile and HOME, so tests run in parallel, also within a file.
 * CI runners are small (each worker is a full Electron app), hence fewer workers there.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/e2e/global-setup.ts',
  workers: process.env.CI ? 2 : 4,
  fullyParallel: true,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  // A test that passes only on its retry is still a failure in CI: retries must not hide races.
  failOnFlakyTests: !!process.env.CI,
  // `test-results/results.json` holds every failure's message and location, so a failed run can be
  // read (`jq`) instead of run again; traces of failed tests sit next to it.
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]]
    : [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  use: { trace: 'retain-on-failure' },
  outputDir: 'test-results',
})
