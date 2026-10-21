import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
})
