import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { Page } from '@playwright/test'

import { expect, type FailableSaves, failableSaves, test } from './fixtures.ts'

test.use({ files: { 'a.md': '# A\n\nStart.\n', 'b.md': '# B\n' } })

const editor = (page: Page) => page.locator('[data-editor] .cm-content')
const bar = (page: Page) => page.locator('[data-conflict]')

declare global {
  interface Window {
    /** Texts of every notice shown since a test started recording them. */
    noticesSeen?: string[]
  }
}

/** Opens a.md, then wraps the page's fetch so its saves can be failed or held. */
async function openWithFailableSaves(page: Page): Promise<FailableSaves> {
  await page.locator('[data-note="a.md"]').click()
  await expect(editor(page)).toContainText('Start.')
  return failableSaves(page)
}

/**
 * Types "Mine." at the end of the open note while saves fail, then waits for the error bar. By default it
 * leaves the editor (which saves at once); `stayInEditor` keeps the cursor there and waits for autosave.
 */
async function typeUnsaved(page: Page, saves: FailableSaves, { stayInEditor = false } = {}): Promise<void> {
  await saves.fail(true)
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('\nMine.', { delay: 20 })
  if (!stayInEditor) await editor(page).blur()
  await expect(page.locator('[data-conflict="error"]')).toBeVisible({ timeout: 20_000 })
}

// A file not yet written reads as '' so expect.poll retries instead of failing on ENOENT.
const onDisk = (vault: string, id: string) => () =>
  readFile(path.join(vault, id), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })

/** Records every notice shown from now on in `window.noticesSeen` (a notice auto-dismisses after a few seconds). */
const recordNotices = (page: Page) =>
  page.evaluate(() => {
    const seen: string[] = []
    window.noticesSeen = seen
    new MutationObserver(() => {
      for (const notice of document.querySelectorAll('[data-notice]')) seen.push(notice.textContent ?? '')
    }).observe(document.body, { childList: true, subtree: true })
  })

/**
 * Puts the page's timers on a paused fake clock, so the 500 ms autosave cannot fire: only a save that
 * runs at once can write the note. Call it before typing; timers created earlier keep the real clock.
 */
async function pauseTimers(page: Page): Promise<void> {
  await page.clock.install()
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000)
}

/** Clicks the error bar's Retry in the page, so the focus stays where it is (no focusout save starts first). */
const clickRetryInPlace = (page: Page) =>
  page.evaluate(() => {
    const retry = [...document.querySelectorAll('[data-conflict="error"] button')].find(
      (button) => button.textContent === 'Retry',
    )
    if (!(retry instanceof HTMLButtonElement)) throw new Error('no Retry button')
    retry.click()
  })

test('Retry shows a notice while the save still fails, and saves once it works', async ({ app }) => {
  const { page, vault } = app
  const saves = await openWithFailableSaves(page)
  await typeUnsaved(page, saves, { stayInEditor: true })
  await expect(editor(page)).toBeFocused()
  await expect(page.locator('[data-conflict="error"]')).toContainText('Saving failed: Disk full')

  await bar(page).getByRole('button', { name: 'Retry' }).click()
  await expect(page.locator('[data-notice][data-kind="error"]')).toContainText('Could not save the note: Disk full')
  expect(await onDisk(vault, 'a.md')()).toBe('# A\n\nStart.\n')
  // Quit asks main's "Quit Anyway?" when this is false.
  expect(await page.evaluate(() => window.boostFlushPendingSave?.())).toBe(false)

  await saves.fail(false)
  await bar(page).getByRole('button', { name: 'Retry' }).click()
  await expect.poll(onDisk(vault, 'a.md'), { timeout: 10_000 }).toMatch(/Start\.\n\nMine\.$/)
  await expect(bar(page)).toHaveCount(0)
  expect(await page.evaluate(() => window.boostFlushPendingSave?.())).toBe(true)
})

test('Retry from the keyboard shows the notice while the save still fails, and keeps focus', async ({ app }) => {
  const { page } = app
  const saves = await openWithFailableSaves(page)
  await typeUnsaved(page, saves, { stayInEditor: true })
  const retry = bar(page).getByRole('button', { name: 'Retry' })

  // Escape lets Tab leave CodeMirror; Shift+Tab then reaches Retry, the control just before the editor.
  await page.keyboard.press('Escape')
  await page.keyboard.press('Shift+Tab')
  await expect(retry).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-notice][data-kind="error"]')).toContainText('Could not save the note: Disk full')
  await expect(retry).toBeFocused()
})

test('quitting after a failed save tries the save again', async ({ app }) => {
  const { page, vault } = app
  const saves = await openWithFailableSaves(page)
  await typeUnsaved(page, saves)
  expect(await page.evaluate(() => window.boostFlushPendingSave?.())).toBe(false)

  await saves.fail(false)
  expect(await page.evaluate(() => window.boostFlushPendingSave?.())).toBe(true)
  expect(await onDisk(vault, 'a.md')()).toMatch(/Start\.\n\nMine\.$/)
  await expect(bar(page)).toHaveCount(0)
})

test('typing while Retry’s save is in flight shows no notice once the save works', async ({ app }) => {
  const { page, vault } = app
  const saves = await openWithFailableSaves(page)
  await typeUnsaved(page, saves, { stayInEditor: true })

  await saves.fail(false)
  await saves.hold()
  await recordNotices(page)
  // The editor keeps the focus, so Retry's own save is the one in flight while the user types.
  await clickRetryInPlace(page)
  await expect.poll(saves.held).toBe(1)
  await expect(editor(page)).toBeFocused()
  await page.keyboard.type(' More.', { delay: 20 })
  await saves.release()
  await expect.poll(onDisk(vault, 'a.md'), { timeout: 10_000 }).toMatch(/Mine\. More\.$/)
  await expect(bar(page)).toHaveCount(0)
  expect(await page.evaluate(() => window.noticesSeen)).toEqual([])
})

test('leaving the editor saves at once with no notice', async ({ app }) => {
  const { page, vault } = app
  await openWithFailableSaves(page)
  await recordNotices(page)
  await pauseTimers(page)
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('\nBlurred.')
  await editor(page).blur()
  await expect.poll(onDisk(vault, 'a.md'), { timeout: 5_000 }).toMatch(/Blurred\.$/)
  expect(await page.evaluate(() => window.noticesSeen)).toEqual([])
})

test('hiding the window saves at once', async ({ app }) => {
  const { page, vault } = app
  await openWithFailableSaves(page)
  await recordNotices(page)
  await pauseTimers(page)
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('\nHidden.')
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(onDisk(vault, 'a.md'), { timeout: 5_000 }).toMatch(/Hidden\.$/)
  expect(await page.evaluate(() => window.noticesSeen)).toEqual([])
})

test('a failing save on leaving the editor shows the bar but no notice', async ({ app }) => {
  const { page } = app
  const saves = await openWithFailableSaves(page)
  await recordNotices(page)
  await pauseTimers(page)
  await saves.fail(true)
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('\nMine.')
  await editor(page).blur()
  await expect(page.locator('[data-conflict="error"]')).toBeVisible()
  expect(await page.evaluate(() => window.noticesSeen)).toEqual([])
})

test('a Retry that fails while a focusout save waits on it still shows its notice', async ({ app }) => {
  const { page } = app
  const saves = await openWithFailableSaves(page)
  await typeUnsaved(page, saves, { stayInEditor: true })
  await expect(editor(page)).toBeFocused()

  // In one task: Retry's save starts, then the editor loses focus, so its save waits on Retry's.
  await page.evaluate(() => {
    const retry = [...document.querySelectorAll('[data-conflict="error"] button')].find(
      (button) => button.textContent === 'Retry',
    )
    if (!(retry instanceof HTMLButtonElement)) throw new Error('no Retry button')
    retry.click()
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
  await expect(page.locator('[data-notice][data-kind="error"]')).toContainText('Could not save the note: Disk full')
})

test('Keep mine overwrites the version that changed on disk', async ({ app }) => {
  const { page, vault } = app
  const saves = await openWithFailableSaves(page)
  await typeUnsaved(page, saves)
  await writeFile(path.join(vault, 'a.md'), '# A\n\nTheirs.\n')
  await expect(page.locator('[data-conflict="changed"]')).toBeVisible({ timeout: 15_000 })

  await saves.fail(false)
  await bar(page).getByRole('button', { name: 'Keep mine' }).click()
  await expect.poll(onDisk(vault, 'a.md'), { timeout: 10_000 }).toMatch(/Start\.\n\nMine\.$/)
  expect(await onDisk(vault, 'a.md')()).not.toContain('Theirs.')
  await expect(bar(page)).toHaveCount(0)
})

test('Keep mine that finds the note gone shows a notice and the removed bar', async ({ app }) => {
  const { page, vault } = app
  const saves = await openWithFailableSaves(page)
  await typeUnsaved(page, saves)
  await writeFile(path.join(vault, 'a.md'), '# A\n\nTheirs.\n')
  await expect(page.locator('[data-conflict="changed"]')).toBeVisible({ timeout: 15_000 })

  // Stands in for the note being deleted on disk just as Keep mine saves it: the wrapper answers the save
  // with 404 (a.md stays on disk).
  await saves.fail(true, 404)
  await bar(page).getByRole('button', { name: 'Keep mine' }).click()
  await expect(page.locator('[data-notice][data-kind="error"]')).toContainText('Could not save the note')
  await expect(page.locator('[data-conflict="removed"]')).toBeVisible()
})

test('Keep mine that meets another change on disk shows a notice and keeps the changed bar', async ({ app }) => {
  const { page, vault } = app
  const saves = await openWithFailableSaves(page)
  await typeUnsaved(page, saves)
  await writeFile(path.join(vault, 'a.md'), '# A\n\nTheirs.\n')
  await expect(page.locator('[data-conflict="changed"]')).toBeVisible({ timeout: 15_000 })

  // Keep mine's save is held until the file has changed on disk again, so the save answers 409.
  await saves.fail(false)
  await saves.hold()
  await bar(page).getByRole('button', { name: 'Keep mine' }).click()
  await expect.poll(saves.held).toBe(1)
  await writeFile(path.join(vault, 'a.md'), '# A\n\nTheirs again.\n')
  await saves.release()
  const notice = page.locator('[data-notice][data-kind="error"]')
  await expect(notice).toContainText('Could not save the note')
  await expect(notice).not.toContainText('Could not save the note:')
  await expect(page.locator('[data-conflict="changed"]')).toBeVisible()
  expect(await onDisk(vault, 'a.md')()).toBe('# A\n\nTheirs again.\n')
})

test('while in conflict, switching to another note is refused and the edits stay', async ({ app }) => {
  const { page, vault } = app
  const saves = await openWithFailableSaves(page)
  await typeUnsaved(page, saves)
  await writeFile(path.join(vault, 'a.md'), '# A\n\nTheirs.\n')
  await expect(page.locator('[data-conflict="changed"]')).toBeVisible({ timeout: 15_000 })
  await saves.fail(false)

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
  const saves = await openWithFailableSaves(page)
  await typeUnsaved(page, saves)
  await rename(path.join(vault, 'a.md'), path.join(vault, 'moved.md'))
  await expect(page.locator('[data-conflict="removed"]')).toBeVisible({ timeout: 15_000 })

  await saves.fail(false)
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

  const tab = page.locator('[role="tab"][data-tab="b.md"]')
  await expect(tab).toHaveCount(1)
  await bar(page).getByRole('button', { name: 'Close', exact: true }).click()
  await expect(tab).toHaveCount(0)
  await expect(page.locator('[data-note-title]')).toHaveCount(0)
  await expect(bar(page)).toHaveCount(0)
})
