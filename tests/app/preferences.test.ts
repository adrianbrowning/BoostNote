import { mkdir, readFile, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    expect(state).toEqual({ ui: DEFAULT_UI, hotkeyRegistered: false, captureHotkeyRegistered: false, update: null })
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
      { tableWidth: 'wide' },
      { tableWidth: 300 },
      { tableWidth: 2001 },
      { tableWidth: 800.5 },
      { tableWidth: 0 },
      { spellcheck: 'yes' },
      { editorFont: 'x; color: red' },
      { editorFont: 'Georgia /*' },
      { editorFont: 'Georgia\\' },
      { panes: { sidebarWidth: 5000 } },
      { panes: { mystery: true } },
      { panes: [] },
      { colour: 'blue' },
      { globalHotkey: 'Shift+A' },
      { globalHotkey: 'Command+Nope' },
      { captureHotkey: 'Shift+A' },
      { captureHotkey: 'Command+Nope' },
      { captureHotkey: 5 },
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

  it('registers a Quick capture hotkey, refuses one the OS does not grant, and turns it off with an empty value', async () => {
    const ok = await app.post(api.preferencesSave.href(), { captureHotkey: 'CommandOrControl+Alt+J' })
    expect(ok.status).toBe(200)
    expect(await readJson<PreferencesState>(ok)).toMatchObject({
      ui: { captureHotkey: 'CommandOrControl+Alt+J' },
      captureHotkeyRegistered: true,
    })
    expect(app.preferences.registeredCaptureHotkey).toBe('CommandOrControl+Alt+J')
    expect(await readJson<PreferencesState>(await app.get(api.preferences.href()))).toMatchObject({
      ui: { captureHotkey: 'CommandOrControl+Alt+J' },
      captureHotkeyRegistered: true,
    })
    expect(new SettingsStore(app.settings.file).ui.captureHotkey).toBe('CommandOrControl+Alt+J')

    app.takenHotkeys.push('Control+Shift+F6')
    const taken = await app.post(api.preferencesSave.href(), { captureHotkey: 'Control+Shift+F6', theme: 'light' })
    expect(taken.status).toBe(409)
    expect(await taken.json()).toEqual({
      error: 'HOTKEY_UNAVAILABLE',
      message: 'Control+Shift+F6 could not be registered. Another app may already use it.',
    })
    expect(app.settings.ui).toMatchObject({ captureHotkey: 'CommandOrControl+Alt+J', theme: 'system' })
    expect(app.preferences.registeredCaptureHotkey).toBe('CommandOrControl+Alt+J')

    const off = await readJson<PreferencesState>(await app.post(api.preferencesSave.href(), { captureHotkey: '' }))
    expect(off).toMatchObject({ ui: { captureHotkey: '' }, captureHotkeyRegistered: false })
    expect(app.preferences.registeredCaptureHotkey).toBeUndefined()
    expect(app.settings.ui.captureHotkey).toBe('')
  })

  it('refuses a Quick capture hotkey equal to the show/hide hotkey, and the reverse, without registering it', async () => {
    await app.post(api.preferencesSave.href(), { globalHotkey: 'CommandOrControl+Alt+K' })
    await app.post(api.preferencesSave.href(), { captureHotkey: 'CommandOrControl+Alt+J' })
    // From here on, neither refused save may register anything, not even for a moment.
    const setHotkey = vi.spyOn(app.preferences, 'setHotkey')
    const setCaptureHotkey = vi.spyOn(app.preferences, 'setCaptureHotkey')

    const capture = await app.post(api.preferencesSave.href(), { captureHotkey: 'CommandOrControl+Alt+K' })
    expect(capture.status).toBe(409)
    expect(await capture.json()).toEqual({
      error: 'HOTKEY_UNAVAILABLE',
      message: 'CommandOrControl+Alt+K is already the show/hide hotkey.',
    })
    const global = await app.post(api.preferencesSave.href(), { globalHotkey: 'CommandOrControl+Alt+J' })
    expect(global.status).toBe(409)
    expect(await global.json()).toEqual({
      error: 'HOTKEY_UNAVAILABLE',
      message: 'CommandOrControl+Alt+J is already the Quick capture hotkey.',
    })
    expect(setHotkey).not.toHaveBeenCalled()
    expect(setCaptureHotkey).not.toHaveBeenCalled()

    expect(app.preferences.registeredHotkey).toBe('CommandOrControl+Alt+K')
    expect(app.preferences.registeredCaptureHotkey).toBe('CommandOrControl+Alt+J')
    expect(app.settings.ui).toMatchObject({
      globalHotkey: 'CommandOrControl+Alt+K',
      captureHotkey: 'CommandOrControl+Alt+J',
    })
  })

  it('puts the show/hide hotkey of a patch back when the Quick capture hotkey of the same patch is refused', async () => {
    await app.post(api.preferencesSave.href(), { globalHotkey: 'CommandOrControl+Alt+K' })
    app.takenHotkeys.push('Control+Shift+F6')

    const taken = await app.post(api.preferencesSave.href(), {
      globalHotkey: 'CommandOrControl+Alt+L',
      captureHotkey: 'Control+Shift+F6',
    })
    expect(taken.status).toBe(409)
    expect(app.preferences.registeredHotkey).toBe('CommandOrControl+Alt+K')
    expect(app.preferences.registeredCaptureHotkey).toBeUndefined()
    expect(app.settings.ui).toMatchObject({ globalHotkey: 'CommandOrControl+Alt+K', captureHotkey: '' })
  })

  it('normalises stored settings field by field', () => {
    expect(normalizeUi({ theme: 'dark', fontSize: 99, panes: { listWidth: 250, sidebarWidth: 'x' } })).toEqual({
      ...DEFAULT_UI,
      theme: 'dark',
      panes: { ...DEFAULT_UI.panes, listWidth: 250 },
    })
    expect(normalizeUi('garbage')).toEqual(DEFAULT_UI)
    expect(normalizeUi({ captureHotkey: 'Shift+A' }).captureHotkey).toBe('')
    expect(normalizeUi({ captureHotkey: 'Control+Alt+J' }).captureHotkey).toBe('Control+Alt+J')
  })

  it('keeps a valid tableWidth and replaces a missing or invalid one with line', () => {
    for (const tableWidth of ['line', 'full', 400, 1200, 2000] as const) {
      expect(normalizeUi({ tableWidth }).tableWidth, String(tableWidth)).toBe(tableWidth)
    }
    for (const tableWidth of [undefined, 'wide', 0, 399, 2001, 800.5, '900', null]) {
      expect(normalizeUi({ tableWidth }).tableWidth, String(tableWidth)).toBe('line')
    }
  })

  it('stores a valid tableWidth', async () => {
    for (const tableWidth of ['full', 1200, 'line'] as const) {
      const response = await app.post(api.preferencesSave.href(), { tableWidth })
      expect(response.status).toBe(200)
      expect((await readJson<PreferencesState>(response)).ui.tableWidth).toBe(tableWidth)
      expect(JSON.parse(await readFile(app.settings.file, 'utf8')).ui.tableWidth).toBe(tableWidth)
    }
  })

  it('drops a stored editorFont that could break out of its css() rule when settings.json loads', async () => {
    await mkdir(path.dirname(app.settings.file), { recursive: true })
    for (const editorFont of ['Georgia /*', 'Geor\\gia']) {
      await writeFile(app.settings.file, JSON.stringify({ ui: { editorFont, fontSize: 18 } }))
      expect(new SettingsStore(app.settings.file).ui).toMatchObject({ editorFont: '', fontSize: 18 })
    }
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
    expect((await vault.findNote('note.md'))?.tags).toEqual(['alpha', 'beta'])
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
