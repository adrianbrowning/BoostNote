import { readFile, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '../../src/app/actions/public/workspace/api.ts'
import { NoteSession } from '../../src/app/actions/public/workspace/note-session.ts'
import type { Vault } from '../../src/vault/index.ts'
import { TestApp } from './helpers.ts'

let app: TestApp
let vault: Vault
let session: NoteSession
/** The page's API client over the current test's router. */
const api = createClient((href, init) => app.fetch(href, init))

beforeEach(async () => {
  app = await TestApp.create()
  vault = await app.openVault()
  session = new NoteSession(api)
})

afterEach(async () => {
  session.close()
  await app.close()
})

/** A new note opened in the session, with `body` on disk. */
async function openNote(body: string) {
  const created = await api.createNote('')
  const note = await api.saveNote({ id: created.id, body, baseHash: created.hash })
  session.open(note)
  return note
}

const onDisk = (id: string) => readFile(path.join(vault.root, id), 'utf8')

describe('NoteSession', () => {
  it('enters conflict when a save answers 409, holding the disk version', async () => {
    const note = await openNote('start\n')
    await writeFile(path.join(vault.root, note.id), 'theirs\n')
    session.edit('mine\n')
    expect(await session.flush()).toBe(false)
    expect(session.state).toBe('conflict')
    expect(session.theirs?.body).toBe('theirs\n')
    expect(await onDisk(note.id)).toBe('theirs\n')
  })

  it('Save my copy writes the editor copy as a new note where the removed one was, keeping the moved disk copy', async () => {
    const note = await openNote('start\n')
    const moved = await api.renameNote(note.id, 'Elsewhere')
    session.edit('mine\n')
    expect(await session.flush()).toBe(false)
    expect(session.state).toBe('removed')

    expect(await session.saveMyCopy()).toEqual({ state: 'saved', error: '' })
    expect(session.state).toBe('saved')
    expect(session.note?.id).toBe(note.id)
    expect(await onDisk(note.id)).toMatch(/\nmine\n$/)
    expect(await onDisk(moved.id)).toMatch(/\nstart\n$/)
  })

  it('Keep mine overwrites the disk copy that caused the conflict', async () => {
    const note = await openNote('start\n')
    await writeFile(path.join(vault.root, note.id), 'theirs\n')
    session.edit('mine\n')
    await session.flush()
    expect(session.state).toBe('conflict')

    expect(await session.keepMine()).toEqual({ state: 'saved', error: '' })
    expect(session.state).toBe('saved')
    expect(session.theirs).toBeNull()
    expect(await onDisk(note.id)).toMatch(/mine\n$/)
    expect(await onDisk(note.id)).not.toMatch(/theirs/)
  })

  it('Load theirs replaces the editor body with the disk version and drops the edits', async () => {
    const note = await openNote('start\n')
    await writeFile(path.join(vault.root, note.id), 'theirs\n')
    session.edit('mine\n')
    await session.flush()
    const docs: string[] = []
    session.addEventListener('doc', (event) => docs.push(event.body))

    session.loadTheirs()
    expect(session.state).toBe('saved')
    expect(session.body).toBe('theirs\n')
    expect(docs).toEqual(['theirs\n'])
    expect(await session.flush()).toBe(true)
    expect(await onDisk(note.id)).toBe('theirs\n')
  })

  it('Retry (a flush in the error state) saves once the failure is gone', async () => {
    let failing = false
    session = new NoteSession(
      createClient((href, init) => (failing ? Promise.reject(new Error('offline')) : app.fetch(href, init))),
    )
    const note = await openNote('start\n')
    failing = true
    session.edit('mine\n')
    expect(await session.flush()).toBe(false)
    expect(session.state).toBe('error')
    expect(session.error).toBe('offline')
    expect(await session.flush()).toBe(false)

    failing = false
    expect(await session.flush()).toBe(true)
    expect(session.state).toBe('saved')
    expect(await onDisk(note.id)).toMatch(/\nmine\n$/)
  })

  it('Retry reports how its own save ended, even when a flush waiting on it has started the next save', async () => {
    // Note saves wait here until the test settles them, in request order.
    const held: Array<(fail: boolean) => void> = []
    let hold = false
    /** Settles the `count`th held save (failing it with "offline" when `fail`), once it has been sent. */
    const settle = async (count: number, fail: boolean) => {
      await vi.waitFor(() => expect(held).toHaveLength(count))
      held[count - 1]?.(fail)
    }
    session = new NoteSession(
      createClient((href, init) => {
        if (!hold || new URL(href, 'http://app').pathname !== '/api/notes/save') return app.fetch(href, init)
        const { promise, resolve, reject } = Promise.withResolvers<Response>()
        held.push((fail) => (fail ? reject(new Error('offline')) : resolve(app.fetch(href, init))))
        return promise
      }),
    )
    const note = await openNote('start\n')
    hold = true
    session.edit('mine\n')
    const autosave = session.flush()
    await settle(1, true)
    expect(await autosave).toBe(false)
    expect(session.state).toBe('error')

    const retry = session.retry()
    // The editor's focusout save, waiting on the same request.
    const focusout = session.flush()
    await settle(2, true)
    expect(await retry).toEqual({ state: 'error', error: 'offline' })
    expect(session.state).toBe('saving')

    await settle(3, false)
    expect(await focusout).toBe(true)
    expect(await onDisk(note.id)).toMatch(/\nmine\n$/)
  })

  it('refuses to flush while in conflict or removed, writing nothing', async () => {
    const note = await openNote('start\n')
    await writeFile(path.join(vault.root, note.id), 'theirs\n')
    session.edit('mine\n')
    await session.flush()
    session.edit('mine, more\n')
    expect(await session.flush()).toBe(false)
    expect(session.state).toBe('conflict')
    expect(await onDisk(note.id)).toBe('theirs\n')

    session.externalRemoval()
    expect(await session.flush()).toBe(false)
    expect(session.state).toBe('removed')
    expect(await onDisk(note.id)).toBe('theirs\n')
  })
})
