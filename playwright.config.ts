import { mkdirSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

// Screenshots of the smoke run land here (referenced by the phase 6 notes).
mkdirSync('/tmp/boost-phase6', { recursive: true })

/** End-to-end smoke tests: the real Electron app from source (`_electron`), one at a time. */
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  workers: 1,
  fullyParallel: false,
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
