import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createEventHub } from '../../src/main/events.ts'
import { SettingsStore } from '../../src/main/settings.ts'
import { MAX_RECENT_VAULTS, VaultSession } from '../../src/main/vault-session.ts'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'boostnote-settings-'))
  file = path.join(dir, 'userData', 'settings.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('SettingsStore', () => {
  it('starts empty and persists updates across instances', () => {
    const store = new SettingsStore(file)
    expect(store.read()).toEqual({})
    store.update({ vaults: ['/a'], lastVault: '/a', windowBounds: { width: 800, height: 600 } })
    expect(new SettingsStore(file).read()).toEqual({
      vaults: ['/a'],
      lastVault: '/a',
      windowBounds: { width: 800, height: 600 },
    })
  })

  it('removes keys set to undefined', async () => {
    const store = new SettingsStore(file)
    store.update({ vaults: ['/a'], lastVault: '/a' })
    store.update({ lastVault: undefined })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ vaults: ['/a'] })
  })

  it('treats malformed files and fields as absent', async () => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, '{ nope')
    expect(new SettingsStore(file).read()).toEqual({})
    await writeFile(file, JSON.stringify({ vaults: [1, 2], lastVault: 3, windowBounds: { width: 1, height: 2 } }))
    expect(new SettingsStore(file).read()).toEqual({ windowBounds: { width: 1, height: 2 } })
  })
})

describe('VaultSession', () => {
  const events = createEventHub()

  async function folder(name: string): Promise<string> {
    const root = path.join(dir, name)
    await mkdir(root, { recursive: true })
    return root
  }

  it('records opened vaults (most recent first) and reopens the last one', async () => {
    const settings = new SettingsStore(file)
    const session = new VaultSession({ settings, events })
    const a = await session.open(await folder('a'))
    const b = await session.open(await folder('b'))
    await session.open(a.root)
    expect(settings.read()).toMatchObject({ vaults: [a.root, b.root], lastVault: a.root })
    await session.dispose()

    const restarted = new VaultSession({ settings: new SettingsStore(file), events })
    expect((await restarted.restore())?.root).toBe(a.root)
    await restarted.close()
    expect(new SettingsStore(file).read()).toEqual({ vaults: [a.root, b.root] })
    expect(await restarted.restore()).toBeUndefined()
  })

  it('keeps the current vault when opening a missing folder, and forgets a missing last vault', async () => {
    const settings = new SettingsStore(file)
    const session = new VaultSession({ settings, events })
    const a = await session.open(await folder('a'))
    await expect(session.open(path.join(dir, 'missing'))).rejects.toMatchObject({ code: 'NOT_A_VAULT' })
    expect(session.current?.root).toBe(a.root)
    await session.dispose()

    settings.update({ lastVault: path.join(dir, 'gone') })
    const restarted = new VaultSession({ settings, events })
    expect(await restarted.restore()).toBeUndefined()
    expect(settings.read().lastVault).toBeUndefined()
  })

  it(`remembers at most ${MAX_RECENT_VAULTS} vaults and can forget one`, async () => {
    const settings = new SettingsStore(file)
    const session = new VaultSession({ settings, events })
    const roots: string[] = []
    for (let index = 0; index < MAX_RECENT_VAULTS + 2; index++)
      roots.push((await session.open(await folder(`v${index}`))).root)
    expect(session.recent).toHaveLength(MAX_RECENT_VAULTS)
    expect(session.recent[0]).toBe(roots.at(-1))
    session.forget(roots.at(-2) ?? '')
    expect(session.recent).not.toContain(roots.at(-2))
    await session.dispose()
  })

  it('forwards external changes to the event hub as vault events', async () => {
    const hub = createEventHub()
    const reader = hub.subscribe().body?.getReader()
    if (!reader) throw new Error('missing body')
    const decoder = new TextDecoder()
    await reader.read() // retry preamble

    const session = new VaultSession({ settings: new SettingsStore(file), events: hub, debounceMs: 20 })
    const vault = await session.open(await folder('watched'))
    await writeFile(path.join(vault.root, 'outside.md'), '# Outside\n')
    await vault.refresh()
    const { value } = await reader.read()
    expect(decoder.decode(value)).toBe(
      'event: vault\ndata: {"type":"vault","change":"note-added","id":"outside.md"}\n\n',
    )
    await session.dispose()
    hub.close()
  })

  describe('open requests', () => {
    it('opens a file in a subfolder of the open vault as that vault’s note', async () => {
      const session = new VaultSession({ settings: new SettingsStore(file), events })
      const vault = await session.open(await folder('open'))
      await mkdir(path.join(vault.root, 'work', 'deep'), { recursive: true })
      await writeFile(path.join(vault.root, 'work', 'deep', 'plan.md'), '# Plan\n')
      session.requestOpen(path.join(vault.root, 'work', 'deep', 'plan.md'))
      expect(await session.takeOpenRequest()).toEqual({ kind: 'note', vault: vault.root, id: 'work/deep/plan.md' })
      expect(await session.takeOpenRequest()).toBeUndefined()
      await session.dispose()
    })

    it('opens a file inside a recent vault in that vault', async () => {
      const session = new VaultSession({ settings: new SettingsStore(file), events })
      const recent = await session.open(await folder('recent'))
      await session.open(await folder('current'))
      await mkdir(path.join(recent.root, 'notes'))
      await writeFile(path.join(recent.root, 'notes', 'old.md'), '# Old\n')
      session.requestOpen(path.join(recent.root, 'notes', 'old.md'))
      expect(await session.takeOpenRequest()).toEqual({ kind: 'note', vault: recent.root, id: 'notes/old.md' })
      await session.dispose()
    })

    it('classifies by real paths, and gives nothing for a missing or non-.md file', async () => {
      const settings = new SettingsStore(file)
      const session = new VaultSession({ settings, events })
      const vault = await session.open(await folder('real-vault'))
      await writeFile(path.join(vault.root, 'target.md'), '# Target\n')
      const links = await folder('links')
      await symlink(path.join(vault.root, 'target.md'), path.join(links, 'alias.md'))
      session.requestOpen(path.join(links, 'alias.md'))
      expect(await session.takeOpenRequest()).toEqual({ kind: 'note', vault: vault.root, id: 'target.md' })

      // A recent vault remembered through a symlinked path still contains the file.
      const other = await folder('other-vault')
      await mkdir(path.join(other, 'sub'))
      await writeFile(path.join(other, 'sub', 'b.md'), '# B\n')
      await symlink(other, path.join(links, 'other-link'))
      await session.close()
      settings.update({ vaults: [path.join(links, 'other-link')] })
      session.requestOpen(path.join(other, 'sub', 'b.md'))
      expect(await session.takeOpenRequest()).toEqual({ kind: 'note', vault: await realpath(other), id: 'sub/b.md' })

      session.requestOpen(path.join(other, 'gone.md'))
      expect(await session.takeOpenRequest()).toBeUndefined()
      await writeFile(path.join(other, 'notes.txt'), 'text\n')
      session.requestOpen(path.join(other, 'notes.txt'))
      expect(await session.takeOpenRequest()).toBeUndefined()
      await session.dispose()
    })

    it('returns every request made before taking, in order; an outside file gets a reader ticket', async () => {
      const settings = new SettingsStore(file)
      const session = new VaultSession({ settings, events })
      const vault = await session.open(await folder('queued'))
      await writeFile(path.join(vault.root, 'first.md'), '# First\n')
      const loose = await folder('loose')
      await writeFile(path.join(loose, 'second.md'), '# Second\n')
      const before = settings.read()
      session.requestOpen(path.join(vault.root, 'first.md'))
      session.requestOpen(path.join(loose, 'second.md'))
      expect(await session.takeOpenRequest()).toEqual({ kind: 'note', vault: vault.root, id: 'first.md' })
      const outside = await session.takeOpenRequest()
      expect(outside).toEqual({ kind: 'external', ticket: expect.any(String), name: 'second.md' })
      expect(await session.takeOpenRequest()).toBeUndefined()
      // The ticket reads the real file; no vault was opened, so Recent and lastVault stay as they were.
      const ticket = outside?.kind === 'external' ? outside.ticket : ''
      expect(session.readers.path(ticket)).toBe(path.join(await realpath(loose), 'second.md'))
      expect(session.current?.root).toBe(vault.root)
      expect(settings.read()).toEqual(before)

      // The same file again (here through a symlink) gets the same live ticket.
      await symlink(path.join(loose, 'second.md'), path.join(loose, 'alias.md'))
      session.requestOpen(path.join(loose, 'alias.md'))
      expect(await session.takeOpenRequest()).toEqual({ kind: 'external', ticket, name: 'second.md' })
      session.readers.revoke(ticket)
      session.requestOpen(path.join(loose, 'second.md'))
      const reopened = await session.takeOpenRequest()
      expect(reopened?.kind === 'external' && reopened.ticket).not.toBe(ticket)
      await session.dispose()
    })

    it('opens outside files with no vault open', async () => {
      const settings = new SettingsStore(file)
      const session = new VaultSession({ settings, events })
      const loose = await folder('loose-alone')
      await writeFile(path.join(loose, 'readme.md'), '# Readme\n')
      session.requestOpen(path.join(loose, 'readme.md'))
      expect(await session.takeOpenRequest()).toEqual({
        kind: 'external',
        ticket: expect.any(String),
        name: 'readme.md',
      })
      expect(session.current).toBeUndefined()
      expect(settings.read()).toEqual({})
    })

    it('opens a file in a hidden or .assets folder of a known vault as an outside file, not a note id', async () => {
      const session = new VaultSession({ settings: new SettingsStore(file), events })
      const vault = await session.open(await folder('git-vault'))
      await mkdir(path.join(vault.root, '.github'))
      await writeFile(path.join(vault.root, '.github', 'x.md'), '# Template\n')
      await mkdir(path.join(vault.root, 'img.assets'))
      await writeFile(path.join(vault.root, 'img.assets', 'readme.md'), '# Readme\n')
      session.requestOpen(path.join(vault.root, '.github', 'x.md'))
      session.requestOpen(path.join(vault.root, 'img.assets', 'readme.md'))
      expect(await session.takeOpenRequest()).toEqual({ kind: 'external', ticket: expect.any(String), name: 'x.md' })
      expect(await session.takeOpenRequest()).toEqual({
        kind: 'external',
        ticket: expect.any(String),
        name: 'readme.md',
      })

      // With "Open its folder as vault" such a file opens its folder as the vault, as before readers.
      await session.dispose()
      const settings = new SettingsStore(file)
      settings.update({ ui: { ...settings.ui, outsideFile: 'vault' } })
      const preferring = new VaultSession({ settings, events })
      await preferring.open(vault.root)
      preferring.requestOpen(path.join(vault.root, '.github', 'x.md'))
      expect(await preferring.takeOpenRequest()).toEqual({
        kind: 'note',
        vault: path.join(vault.root, '.github'),
        id: 'x.md',
      })
      await preferring.dispose()
    })

    it('stops at the first known vault holding the file, even when a later recent vault is nested inside it', async () => {
      const settings = new SettingsStore(file)
      const session = new VaultSession({ settings, events })
      const vault = await session.open(await folder('outer-vault'))
      await mkdir(path.join(vault.root, '.github', 'sub'), { recursive: true })
      await writeFile(path.join(vault.root, '.github', 'sub', 'x.md'), '# X\n')
      settings.update({ vaults: [vault.root, path.join(vault.root, '.github')] })
      session.requestOpen(path.join(vault.root, '.github', 'sub', 'x.md'))
      expect(await session.takeOpenRequest()).toEqual({ kind: 'external', ticket: expect.any(String), name: 'x.md' })
      await session.dispose()
    })

    it('with "Open its folder as vault", opens an outside file’s folder as the vault; known vaults still win', async () => {
      const settings = new SettingsStore(file)
      settings.update({ ui: { ...settings.ui, outsideFile: 'vault' } })
      const session = new VaultSession({ settings, events })
      const vault = await session.open(await folder('pref-vault'))
      await mkdir(path.join(vault.root, 'sub'))
      await writeFile(path.join(vault.root, 'sub', 'in.md'), '# In\n')
      const recent = await session.open(await folder('pref-recent'))
      await writeFile(path.join(recent.root, 'old.md'), '# Old\n')
      await session.open(vault.root)
      const loose = await folder('pref-loose')
      await writeFile(path.join(loose, 'readme.md'), '# Readme\n')

      session.requestOpen(path.join(loose, 'readme.md'))
      session.requestOpen(path.join(vault.root, 'sub', 'in.md'))
      session.requestOpen(path.join(recent.root, 'old.md'))
      expect(await session.takeOpenRequest()).toEqual({ kind: 'note', vault: await realpath(loose), id: 'readme.md' })
      // A file in a subfolder of the open vault is that vault's note, not a new vault of the subfolder.
      expect(await session.takeOpenRequest()).toEqual({ kind: 'note', vault: vault.root, id: 'sub/in.md' })
      expect(await session.takeOpenRequest()).toEqual({ kind: 'note', vault: recent.root, id: 'old.md' })
      await session.dispose()
    })

    it('opens upper-case .MD files and dot-names read-only in both preference modes, also inside a known vault', async () => {
      const settings = new SettingsStore(file)
      const session = new VaultSession({ settings, events })
      const vault = await session.open(await folder('upper-vault'))
      await writeFile(path.join(vault.root, 'NOTES.MD'), '# In vault\n')
      const loose = await folder('names')
      await writeFile(path.join(loose, 'README.MD'), '# Upper\n')
      await writeFile(path.join(loose, '.hidden.md'), '# Hidden\n')
      const reader = (name: string) => ({ kind: 'external', ticket: expect.any(String), name })

      // No vault would hold these as notes (notes end in lower-case .md and never start with a dot).
      for (const outsideFile of ['reader', 'vault'] as const) {
        settings.update({ ui: { ...settings.ui, outsideFile } })
        session.requestOpen(path.join(loose, 'README.MD'))
        session.requestOpen(path.join(loose, '.hidden.md'))
        session.requestOpen(path.join(vault.root, 'NOTES.MD'))
        expect(await session.takeOpenRequest()).toEqual(reader('README.MD'))
        expect(await session.takeOpenRequest()).toEqual(reader('.hidden.md'))
        expect(await session.takeOpenRequest()).toEqual(reader('NOTES.MD'))
        expect(await session.takeOpenRequest()).toBeUndefined()
      }
      expect(session.current?.root).toBe(vault.root)
      await session.dispose()
    })
  })

  it('"Open folder as vault" and closing the same reader run in order: whichever came first wins', async () => {
    const settings = new SettingsStore(file)
    const session = new VaultSession({ settings, events })
    const vault = await session.open(await folder('kept'))
    const loose = await folder('closing')
    await writeFile(path.join(loose, 'readme.md'), '# Readme\n')
    const reader = async () => {
      session.requestOpen(path.join(loose, 'readme.md'))
      const request = await session.takeOpenRequest()
      return request?.kind === 'external' ? request.ticket : ''
    }

    // Close first, while a vault switch is in flight: the open-folder after it opens nothing.
    const first = await reader()
    const switching = session.open(vault.root)
    const closing = session.closeReader(first)
    const refused = session.openReaderFolder(first)
    await switching
    expect(await closing).toBe(true)
    await expect(refused).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(session.current?.root).toBe(vault.root)
    expect(settings.read().lastVault).toBe(vault.root)

    // Open-folder first: it switches, and the close after it finds the ticket already revoked.
    const second = await reader()
    const opening = session.openReaderFolder(second)
    const late = session.closeReader(second)
    expect(await opening).toBe('readme.md')
    expect(await late).toBe(false)
    expect(session.current?.root).toBe(await realpath(loose))
    await session.dispose()
  })
})
