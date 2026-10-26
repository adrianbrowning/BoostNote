import { readFile, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { NoteDocument, PreferencesState } from '../../src/app/actions/public/workspace/types.ts'
import { routes } from '../../src/app/routes.ts'
import { DEFAULT_HOTKEY, DEFAULT_UI, isAccelerator, normalizeUi, SettingsStore } from '../../src/main/settings.ts'
import { TestApp } from './helpers.ts'

const api = routes.api
let app: TestApp

beforeEach(async () => {
  app = await TestApp.create()
})

afterEach(async () => {
  await app.close()
})

async function readJson<T>(response: Response): Promise<T> {
  const body: T = await response.json()
  return body
}

describe('preferences route', () => {
  it('answers the defaults when nothing is stored', async () => {
    const state = await readJson<PreferencesState>(await app.get(api.preferences.href()))
    expect(state).toEqual({ ui: DEFAULT_UI, hotkeyRegistered: false, update: null })
  })

  it('stores a valid patch in settings.json and applies it', async () => {
    const response = await app.post(api.preferencesSave.href(), {
      theme: 'dark',
      fontSize: 18,
      lineWidth: 0,
      editorFont: 'Georgia, serif',
      panes: { sidebarWidth: 300, propertiesOpen: true },
    })
    expect(response.status).toBe(200)
    const state = await readJson<PreferencesState>(response)
    expect(state.ui).toMatchObject({ theme: 'dark', fontSize: 18, lineWidth: 0, editorFont: 'Georgia, serif' })
    expect(state.ui.panes).toEqual({ ...DEFAULT_UI.panes, sidebarWidth: 300, propertiesOpen: true })
    expect(app.applied.at(-1)).toEqual(state.ui)

    const stored = JSON.parse(await readFile(app.settings.file, 'utf8'))
    expect(stored.ui).toEqual(state.ui)
    expect(new SettingsStore(app.settings.file).ui).toEqual(state.ui)
  })

  it('rejects unknown keys and invalid values without storing anything', async () => {
    const bad = [
      { theme: 'sepia' },
      { fontSize: 4 },
      { fontSize: '16' },
      { lineWidth: 100 },
      { spellcheck: 'yes' },
      { editorFont: 'x; color: red' },
      { panes: { sidebarWidth: 5000 } },
      { panes: { mystery: true } },
      { panes: [] },
      { colour: 'blue' },
      { globalHotkey: 'Shift+A' },
      { globalHotkey: 'Command+Nope' },
    ]
    for (const body of bad) {
      const response = await app.post(api.preferencesSave.href(), body)
      expect(response.status, JSON.stringify(body)).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'BAD_REQUEST' })
    }
    expect(app.settings.read().ui).toBeUndefined()
    expect(app.applied).toEqual([])
  })

  it('registers a new global hotkey, and refuses one the OS does not grant', async () => {
    const ok = await readJson<PreferencesState>(
      await app.post(api.preferencesSave.href(), { globalHotkey: 'CommandOrControl+Alt+K' }),
    )
    expect(ok).toMatchObject({ ui: { globalHotkey: 'CommandOrControl+Alt+K' }, hotkeyRegistered: true })
    expect(app.preferences.registeredHotkey).toBe('CommandOrControl+Alt+K')

    app.takenHotkeys.push('Control+Shift+F5')
    const taken = await app.post(api.preferencesSave.href(), { globalHotkey: 'Control+Shift+F5', theme: 'light' })
    expect(taken.status).toBe(409)
    expect(await taken.json()).toMatchObject({ error: 'HOTKEY_UNAVAILABLE' })
    expect(app.settings.ui).toMatchObject({ globalHotkey: 'CommandOrControl+Alt+K', theme: 'system' })
    expect(app.preferences.registeredHotkey).toBe('CommandOrControl+Alt+K')

    const off = await readJson<PreferencesState>(await app.post(api.preferencesSave.href(), { globalHotkey: '' }))
    expect(off).toMatchObject({ ui: { globalHotkey: '' }, hotkeyRegistered: false })
    expect(app.preferences.registeredHotkey).toBeUndefined()
  })

  it('normalises stored settings field by field', () => {
    expect(normalizeUi({ theme: 'dark', fontSize: 99, panes: { listWidth: 250, sidebarWidth: 'x' } })).toEqual({
      ...DEFAULT_UI,
      theme: 'dark',
      panes: { ...DEFAULT_UI.panes, listWidth: 250 },
    })
    expect(normalizeUi('garbage')).toEqual(DEFAULT_UI)
  })

  it('validates accelerators', () => {
    for (const valid of [DEFAULT_HOTKEY, 'Command+Shift+Space', 'Control+Alt+L', 'F5', 'Super+Plus', 'Alt+[']) {
      expect(isAccelerator(valid), valid).toBe(true)
    }
    for (const invalid of ['', 'A', 'Shift+A', 'Command', 'Command+Command+A', 'Hyper+A', 'Command+AB']) {
      expect(isAccelerator(invalid), invalid).toBe(false)
    }
  })
})

describe('properties panel saves', () => {
  it('rewrites only the edited keys of the frontmatter', async () => {
    const vault = await app.openVault()
    const yaml = [
      '---',
      "title: 'Quoted title'   # keep me",
      'tags: [alpha]',
      'rating: 3',
      'meta:',
      '  nested: {a: 1}',
      'created: 2026-01-01T00:00:00.000Z',
      '---',
      '# Body',
      '',
    ].join('\n')
    await writeFile(path.join(vault.root, 'note.md'), yaml)
    await vault.refresh()
    const note = await readJson<NoteDocument>(await app.get(`${api.noteRead.href()}?id=note.md`))

    // Add a tag, rename `rating` to `score` (same position), add a property; `meta` and `title` untouched.
    const { rating, ...rest } = note.frontmatter
    const entries = Object.entries({ ...rest, tags: ['alpha', 'beta'] })
    const frontmatter = Object.fromEntries([
      ...entries.slice(0, 2),
      ['score', rating ?? null],
      ...entries.slice(2),
      ['due', '2026-11-01'],
    ])
    const saved = await app.post(api.noteSave.href(), {
      id: 'note.md',
      body: note.body,
      baseHash: note.hash,
      frontmatter,
    })
    expect(saved.status).toBe(200)
    expect((await readJson<NoteDocument>(saved)).tags).toEqual(['alpha', 'beta'])

    const raw = await readFile(path.join(vault.root, 'note.md'), 'utf8')
    expect(raw).toContain("title: 'Quoted title'   # keep me\n")
    expect(raw).toContain('meta:\n  nested: {a: 1}\n')
    expect(raw).toContain('created: 2026-01-01T00:00:00.000Z\n')
    expect(raw).toMatch(/tags:\s*\n\s+- alpha\n\s+- beta\n/)
    expect(raw).toContain('score: 3\n')
    expect(raw).not.toContain('rating')
    expect(raw).toContain('due: 2026-11-01\n')
    expect(raw.endsWith('---\n# Body\n')).toBe(true)
    expect(vault.index.get('note.md')?.tags).toEqual(['alpha', 'beta'])
  })

  it('edits a tag in place, keeping every other byte', async () => {
    const vault = await app.openVault()
    const head = '---\ntitle: "Kept"  # comment\ntags: [alpha]\nextra: \'x\'\n'
    await writeFile(path.join(vault.root, 'n.md'), `${head}updated: 2026-01-01T00:00:00.000Z\n---\nBody\n`)
    await vault.refresh()
    const note = await readJson<NoteDocument>(await app.get(`${api.noteRead.href()}?id=n.md`))
    const response = await app.post(api.noteSave.href(), {
      id: 'n.md',
      body: note.body,
      baseHash: note.hash,
      frontmatter: { ...note.frontmatter, tags: ['alpha', 'beta'] },
    })
    expect(response.status).toBe(200)
    const raw = await readFile(path.join(vault.root, 'n.md'), 'utf8')
    expect(raw).toMatch(
      /^---\ntitle: "Kept" {2}# comment\ntags:\n {2}- alpha\n {2}- beta\nextra: 'x'\nupdated: .+\ncreated: .+\n---\nBody\n$/,
    )
  })
})
