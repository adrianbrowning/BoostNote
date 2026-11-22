import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { Page } from '@playwright/test'

import { expect, test } from './fixtures.ts'

test.use({ files: { 'a.md': '# A\n\nStart.\n', 'b.md': '# B\n' } })

const editor = (page: Page) => page.locator('[data-editor] .cm-content')
const bar = (page: Page) => page.locator('[data-conflict]')

declare global {
  interface Window {
    /** This spec's page-side fetch wrapper: every note save fails while `fail` is set. */
    failingSaves?: { fail: boolean }
  }
}

/** Opens a.md and wraps the page's fetch so saves can be failed (`page.route` misses `boost://`). */
async function openWithFailableSaves(page: Page): Promise<(fail: boolean) => Promise<void>> {
  await page.locator('[data-note="a.md"]').click()
  await expect(editor(page)).toContainText('Start.')
  await page.evaluate(() => {
    const original = window.fetch
    const state = { fail: false }
    window.failingSaves = state
    window.fetch = (input, init) => {
      const { pathname } = new URL(String(input), location.href)
      if (pathname === '/api/notes/save' && state.fail) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'IO', message: 'Disk full' }), { status: 500 }))
      }
      return original(input, init)
    }
  })
  return (fail) =>
    page.evaluate((value) => {
      if (window.failingSaves) window.failingSaves.fail = value
    }, fail)
}

/**
 * Types "Mine." at the end of the open note while saves fail, then waits for the error bar. By default it
 * leaves the editor (which saves at once); `stayInEditor` keeps the cursor there and waits for autosave.
 */
async function typeUnsaved(
  page: Page,
  failSaves: (fail: boolean) => Promise<void>,
  { stayInEditor = false } = {},
): Promise<void> {
  await failSaves(true)
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('\nMine.', { delay: 20 })
  if (!stayInEditor) await editor(page).blur()
  await expect(page.locator('[data-conflict="error"]')).toBeVisible({ timeout: 20_000 })
}

const onDisk = (vault: string, id: string) => () => readFile(path.join(vault, id), 'utf8')

test('Retry shows a notice while the save still fails, and saves once it works', async ({ app }) => {
  const { page, vault } = app
  const failSaves = await openWithFailableSaves(page)
  await typeUnsaved(page, failSaves, { stayInEditor: true })
  await expect(editor(page)).toBeFocused()
  await expect(page.locator('[data-conflict="error"]')).toContainText('Saving failed: Disk full')

  await bar(page).getByRole('button', { name: 'Retry' }).click()
  await expect(page.locator('[data-notice][data-kind="error"]')).toContainText('Could not save the note: Disk full')
  expect(await onDisk(vault, 'a.md')()).toBe('# A\n\nStart.\n')
  // Quit asks main's "Quit Anyway?" when this is false.
  expect(await page.evaluate(() => window.boostFlushPendingSave?.())).toBe(false)

  await failSaves(false)
  await bar(page).getByRole('button', { name: 'Retry' }).click()
  await expect.poll(onDisk(vault, 'a.md'), { timeout: 10_000 }).toMatch(/Start\.\n\nMine\.$/)
  await expect(bar(page)).toHaveCount(0)
  expect(await page.evaluate(() => window.boostFlushPendingSave?.())).toBe(true)
})

test('Keep mine overwrites the version that changed on disk', async ({ app }) => {
  const { page, vault } = app
  const failSaves = await openWithFailableSaves(page)
  await typeUnsaved(page, failSaves)
  await writeFile(path.join(vault, 'a.md'), '# A\n\nTheirs.\n')
  await expect(page.locator('[data-conflict="changed"]')).toBeVisible({ timeout: 15_000 })

  await failSaves(false)
  await bar(page).getByRole('button', { name: 'Keep mine' }).click()
  await expect.poll(onDisk(vault, 'a.md'), { timeout: 10_000 }).toMatch(/Start\.\n\nMine\.$/)
  expect(await onDisk(vault, 'a.md')()).not.toContain('Theirs.')
  await expect(bar(page)).toHaveCount(0)
})

test('while in conflict, switching to another note is refused and the edits stay', async ({ app }) => {
  const { page, vault } = app
  const failSaves = await openWithFailableSaves(page)
  await typeUnsaved(page, failSaves)
  await writeFile(path.join(vault, 'a.md'), '# A\n\nTheirs.\n')
  await expect(page.locator('[data-conflict="changed"]')).toBeVisible({ timeout: 15_000 })
  await failSaves(false)

  await page.locator('[data-note="b.md"]').click()
  await expect(page.locator('[data-notice][data-kind="error"]')).toContainText('could not be saved')
  await expect(page.locator('[data-note-title]')).toHaveText('a')
  await expect(editor(page)).toContainText('Mine.')
  await expect(page.locator('[data-conflict="changed"]')).toBeVisible()
  expect(await onDisk(vault, 'a.md')()).toBe('# A\n\nTheirs.\n')
})

test('Save my copy writes the edits back where a note moved away on disk was, keeping the moved file', async ({
  app,
}) => {
  const { page, vault } = app
  const failSaves = await openWithFailableSaves(page)
  await typeUnsaved(page, failSaves)
  await rename(path.join(vault, 'a.md'), path.join(vault, 'moved.md'))
  await expect(page.locator('[data-conflict="removed"]')).toBeVisible({ timeout: 15_000 })

  await failSaves(false)
  await bar(page).getByRole('button', { name: 'Save my copy' }).click()
  await expect.poll(onDisk(vault, 'a.md'), { timeout: 10_000 }).toMatch(/Start\.\n\nMine\.$/)
  expect(await onDisk(vault, 'moved.md')()).toBe('# A\n\nStart.\n')
  await expect(bar(page)).toHaveCount(0)
})

test('the removed bar’s Close discards the note and closes its tab', async ({ app }) => {
  const { page, vault } = app
  await page.locator('[data-note="b.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('b')
  await rm(path.join(vault, 'b.md'))
  await expect(page.locator('[data-conflict="removed"]')).toBeVisible({ timeout: 15_000 })

  await bar(page).getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.locator('[role="tab"][data-tab="b.md"]')).toHaveCount(0)
  await expect(page.locator('[data-note-title]')).toHaveCount(0)
  await expect(bar(page)).toHaveCount(0)
})
