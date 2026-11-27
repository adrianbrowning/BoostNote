import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import CSON from 'cson-parser'

import { openLooseFile, writeFiles } from '../e2e/fixtures.ts'
import { DOCS_VAULT, expect, test } from './fixtures.ts'

/**
 * Drops files from disk onto `selector` as tests/e2e/drop.spec.ts does: real `File`s from a file input (so they carry
 * their paths) in a `DataTransfer`, dispatched as `dragenter` + `dragover` + `drop`. The app's real drop handler runs.
 */
async function dropFiles(page: Page, selector: string, files: string[]): Promise<void> {
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.hidden = true
    input.id = 'docs-drop-files'
    document.body.append(input)
  })
  await page.setInputFiles('#docs-drop-files', files)
  await page
    .locator(selector)
    .first()
    .evaluate((target) => {
      const input = document.querySelector<HTMLInputElement>('#docs-drop-files')
      const data = new DataTransfer()
      for (const file of input?.files ?? []) data.items.add(file)
      const init = { bubbles: true, cancelable: true, composed: true, dataTransfer: data }
      target.dispatchEvent(new DragEvent('dragenter', init))
      target.dispatchEvent(new DragEvent('dragover', init))
      target.dispatchEvent(new DragEvent('drop', init))
      input?.remove()
    })
}

/** A small legacy Boostnote storage: two folders, three notes, as the legacy app wrote them. */
async function writeLegacyStorage(storage: string): Promise<void> {
  const work = 'a1b2c3d4e5f6a7b8c9d0'
  const home = 'b2c3d4e5f6a7b8c9d0e1'
  await mkdir(path.join(storage, 'notes'), { recursive: true })
  await writeFile(
    path.join(storage, 'boostnote.json'),
    JSON.stringify({
      folders: [
        { key: work, name: 'Work', color: '#1278BD' },
        { key: home, name: 'Home', color: '#30D5C8' },
      ],
      version: '1.0',
    }),
  )
  const notes = [
    { key: '0b3e1c2a-4d5f-4a6b-8c7d-9e0f1a2b3c4d', folder: work, title: 'Release checklist', tags: ['work'] },
    { key: '1c4f2d3b-5e6a-4b7c-9d8e-0f1a2b3c4d5e', folder: work, title: 'Team contacts', tags: [] },
    { key: '2d5a3e4c-6f7b-4c8d-ae9f-1a2b3c4d5e6f', folder: home, title: 'Shopping list', tags: ['home'] },
  ]
  for (const note of notes) {
    const data = {
      createdAt: new Date('2019-03-01T10:00:00.000Z'),
      updatedAt: new Date('2019-04-02T11:30:00.000Z'),
      type: 'MARKDOWN_NOTE',
      folder: note.folder,
      title: note.title,
      tags: note.tags,
      content: `# ${note.title}\n\n- [ ] First item\n`,
      isStarred: false,
      isTrashed: false,
    }
    await writeFile(path.join(storage, 'notes', `${note.key}.cson`), CSON.stringify(data, null, 2))
  }
}

test('a folder row highlighted while files are dragged over it', async ({ docsApp }) => {
  const { page } = docsApp
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.items.add(new File(['x'], 'x.md'))
    document
      .querySelector('[data-folder="Recipes"]')
      ?.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }))
  })
  await expect(page.locator('[data-folder="Recipes"]')).toHaveAttribute('data-drop-target', 'true')
  await docsApp.shot('bring-notes-in-drop-target', page.getByRole('navigation', { name: 'Vault' }))
})

test('notes dropped into the selected folder, with the import notice', async ({ docsApp }) => {
  const { page, dir } = docsApp
  const src = path.join(dir, 'drop-src')
  await writeFiles(src, {
    'Garden plan.md':
      '# Garden plan\n\nPlant the beans in May. The seeds are in the [seed list](Seed%20list.md).\n\n![Harvest per month](harvest.png)\n',
    'Seed list.md': '# Seed list\n\n- [ ] Beans\n- [ ] Tomatoes\n- [x] Basil\n',
    'shopping.txt': 'compost\n',
  })
  await copyFile(path.join(DOCS_VAULT, 'Markdown tour.assets', 'chart.png'), path.join(src, 'harvest.png'))
  await page.locator('[data-folder="Personal"]').getByTitle('Personal').click()
  await dropFiles(
    page,
    'section[aria-label="Notes"]',
    ['Garden plan.md', 'Seed list.md', 'shopping.txt'].map((name) => path.join(src, name)),
  )
  const notice = page.locator('[data-notice]')
  await expect(notice).toContainText('Imported 2 notes into Personal (1 image copied, 1 skipped)')
  await page.locator('[data-note="Personal/Garden plan.md"]').click()
  await expect(page.locator('[data-note-title]')).toHaveText('Garden plan')
  await expect(page.locator('[data-editor] img[alt="Harvest per month"]')).toBeVisible()
  await expect(notice).toBeVisible()
  await docsApp.shot('bring-notes-in-drop-notice')
})

test('a file opened from outside the vault, and Add to vault', async ({ docsApp }) => {
  const { page } = docsApp
  await openLooseFile(
    docsApp,
    'Packing list.md',
    '# Packing list\n\nFor the trip in December.\n\n- [x] Passport\n- [ ] Charger\n- [ ] Warm coat\n',
  )
  await expect(page.locator('[data-reader-body] h1')).toHaveText('Packing list')
  await docsApp.shot('bring-notes-in-reader')
  await page.locator('[data-reader-add]').click()
  const dialog = page.getByRole('dialog', { name: 'Add to vault' })
  await dialog.locator('select').selectOption('Personal')
  await docsApp.shot('bring-notes-in-add-to-vault', dialog.locator('form'), { padding: 16 })
})

test('the Import Boostnote storage dialog after Preview', async ({ docsApp, theme }) => {
  const { page } = docsApp
  // A short, fixed folder per theme, so the dialog's fields show readable paths that stay the same on
  // every run (the test's own temp folder has a long, random path). Not under the test home, so the
  // dialog lists no "Found:" storage button either.
  const root = `/tmp/boostnote-docs-import-${theme}`
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  try {
    const storage = path.join(root, 'Boostnote')
    await writeLegacyStorage(storage)
    await docsApp.clickMenu('import-storage')
    const dialog = page.getByRole('dialog', { name: 'Import Boostnote storage' })
    await dialog.locator('input[name="source"]').fill(storage)
    await dialog.locator('input[name="target"]').fill(path.join(root, 'Imported notes'))
    await dialog.locator('[data-import-preview]').click()
    await expect(dialog.locator('[data-import-summary="preview"]')).toBeVisible()
    await docsApp.shot('bring-notes-in-import-storage', dialog.locator('form'), { padding: 16 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.describe('slug file names', () => {
  test.use({
    files: {
      'Work/team-offsite-agenda.md': '# Team offsite agenda\n\n- Goals for next year\n',
      'Personal/garden-plan.md': '# Garden plan\n\nPlant the beans in May.\n',
    },
  })

  test('the Rename files from titles dialog', async ({ docsApp }) => {
    const { page } = docsApp
    await expect(page.locator('[data-note="Work/team-offsite-agenda.md"]')).toBeAttached()
    await docsApp.clickMenu('rename-from-titles')
    const dialog = page.getByRole('dialog', { name: 'Rename files from titles' })
    await expect(dialog.locator('[data-title-rename="Work/team-offsite-agenda.md"]')).toContainText(
      'Team offsite agenda',
    )
    await docsApp.shot('bring-notes-in-rename-from-titles', dialog.locator('form'), { padding: 16 })
  })
})
