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
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: 'test-results',
})
