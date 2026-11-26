import { access, readFile, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, type NoteApi } from '../../src/app/actions/public/workspace/api.ts'
import { NoteSession } from '../../src/app/actions/public/workspace/note-session.ts'
import type { Vault } from '../../src/vault/index.ts'
import { heldClient, TestApp } from './helpers.ts'

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

/** A new note opened in the session, with `body` (and `frontmatter`, if given) on disk. */
async function openNote(body: string, frontmatter?: Record<string, string[]>) {
  const created = await api.createNote('')
  const note = await api.saveNote({
    id: created.id,
    body,
    baseHash: created.hash,
    ...(frontmatter ? { frontmatter } : {}),
  })
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

  it('Save my copy writes the editor copy as a new note where the removed one was, keeping the moved disk copy and the frontmatter', async () => {
    const note = await openNote('start\n', { tags: ['x'] })
    const { note: moved } = await api.renameNote(note.id, 'Elsewhere')
    session.edit('mine\n')
    expect(await session.flush()).toBe(false)
    expect(session.state).toBe('removed')

    expect(await session.saveMyCopy()).toEqual({ state: 'saved' })
    expect(session.state).toBe('saved')
    expect(session.note?.id).toBe(note.id)
    expect(await onDisk(note.id)).toMatch(/\nmine\n$/)
    expect(await onDisk(moved.id)).toMatch(/\nstart\n$/)
    expect((await api.readNote(note.id)).frontmatter.tags).toEqual(['x'])
  })

  it('Keep mine overwrites the disk copy that caused the conflict', async () => {
    const note = await openNote('start\n')
    await writeFile(path.join(vault.root, note.id), 'theirs\n')
    session.edit('mine\n')
    await session.flush()
    expect(session.state).toBe('conflict')

    expect(await session.keepMine()).toEqual({ state: 'saved' })
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

  it('Retry saves once the failure is gone, keeping the error message until a save works', async () => {
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
    expect(await session.retry()).toEqual({ state: 'error', error: 'offline' })

    failing = false
    const retry = session.retry()
    // The error bar (with its message) stays up while Retry's own save is in flight.
    expect(session.state).toBe('retrying')
    expect(session.error).toBe('offline')
    expect(await retry).toEqual({ state: 'saved' })
    expect(session.state).toBe('saved')
    expect(session.error).toBe('')
    expect(await onDisk(note.id)).toMatch(/\nmine\n$/)
  })

  it('only a save started in the error state is retrying, even when the failure has no message', async () => {
    let failing = false
    session = new NoteSession(
      createClient((href, init) => (failing ? Promise.reject(new Error('')) : app.fetch(href, init))),
    )
    await openNote('start\n')
    failing = true
    session.edit('mine\n')
    expect(await session.flush()).toBe(false)
    expect(session.state).toBe('error')
    expect(session.error).toBe('')

    const retry = session.retry()
    expect(session.state).toBe('retrying')
    expect(await retry).toEqual({ state: 'error', error: '' })
    expect(session.state).toBe('error')

    session.edit('mine again\n')
    const save = session.flush()
    expect(session.state).toBe('saving')
    expect(await save).toBe(false)
  })

  /** A note client whose saves, once `hold()` was called, wait until the test settles them in request order. */
  interface HeldSaves {
    client: NoteApi
    hold(): void
    /** Waits until `count` saves were sent. */
    sent(count: number): Promise<void>
    /** Settles the `count`th held save (failing it with "offline" when `fail`), once it has been sent. */
    settle(count: number, fail: boolean): Promise<void>
  }

  function heldSaves(): HeldSaves {
    const net = heldClient(app)
    return {
      client: net.client,
      hold: () => net.hold((url) => (url.pathname === '/api/notes/save' ? 'save' : undefined)),
      sent: async (count) => {
        await vi.waitFor(() => expect(net.held).toHaveLength(count))
      },
      settle: async (count, fail) => {
        await vi.waitFor(() => expect(net.held).toHaveLength(count))
        net.held[count - 1]?.release(fail ? 'offline' : undefined)
      },
    }
  }

  /** Opens a note whose saves `saves` holds, and puts it in the error state with an unsaved "mine". */
  async function failedSave(saves: HeldSaves) {
    session = new NoteSession(saves.client)
    const note = await openNote('start\n')
    saves.hold()
    session.edit('mine\n')
    const autosave = session.flush()
    await saves.settle(1, true)
    expect(await autosave).toBe(false)
    expect(session.state).toBe('error')
    return note
  }

  it('Retry reports how its own save ended, even when a flush waiting on it has started the next save', async () => {
    const saves = heldSaves()
    const note = await failedSave(saves)
    const { settle } = saves

    const retry = session.retry()
    // The editor's focusout save, waiting on the same request.
    const focusout = session.flush()
    await settle(2, true)
    expect(await retry).toEqual({ state: 'error', error: 'offline' })
    // The focusout flush started the next save from the error state.
    expect(session.state).toBe('retrying')

    await settle(3, false)
    expect(await focusout).toBe(true)
    expect(await onDisk(note.id)).toMatch(/\nmine\n$/)
  })

  it('Retry queued behind another waiter resolves to a save that ran after it, never to the save in between', async () => {
    const saves = heldSaves()
    await failedSave(saves)
    const { sent, settle } = saves

    // A leftover autosave retries; the editor's focusout save, then Retry, wait on it, in that order.
    void session.flush()
    const focusout = session.flush()
    let outcome: unknown
    const retry = session.retry().then((result) => {
      outcome = result
      return result
    })
    await settle(2, true)
    // The focusout flush has started the next save; Retry waits for that one too.
    await sent(3)
    expect(outcome).toBeUndefined()

    await settle(3, true)
    expect(await focusout).toBe(false)
    // That save failed as well, so Retry sends its own.
    await settle(4, true)
    expect(await retry).toEqual({ state: 'error', error: 'offline' })
  })

  it('refuses to flush while in conflict or removed, writing nothing', async () => {
    let saves = 0
    session = new NoteSession(
      createClient((href, init) => {
        if (new URL(href, 'http://app').pathname === '/api/notes/save') saves++
        return app.fetch(href, init)
      }),
    )
    const note = await openNote('start\n')
    await writeFile(path.join(vault.root, note.id), 'theirs\n')
    session.edit('mine\n')
    await session.flush()
    expect(session.state).toBe('conflict')
    saves = 0

    session.edit('mine, more\n')
    expect(await session.flush()).toBe(false)
    expect(session.state).toBe('conflict')
    expect(await onDisk(note.id)).toBe('theirs\n')
    expect(saves).toBe(0)

    session.externalRemoval()
    expect(await session.flush()).toBe(false)
    expect(session.state).toBe('removed')
    expect(await onDisk(note.id)).toBe('theirs\n')
    expect(saves).toBe(0)
  })

  it('a save that throws before it is sent fails like any other, and later flushes still settle', async () => {
    const throwing: NoteApi = {
      readNote: api.readNote,
      saveNote: () => {
        throw new Error('Not JSON')
      },
      uploadAsset: api.uploadAsset,
      writeScratch: api.writeScratch,
    }
    session = new NoteSession(throwing)
    session.open(await api.createNote(''))
    session.edit('mine\n')
    expect(await session.flush()).toBe(false)
    expect(session.state).toBe('error')
    // A save that threw before it was sent leaves no save in flight: this flush settles instead of waiting forever.
    expect(await session.flush()).toBe(false)
  })

  describe('an outside edit’s read that returns late', () => {
    /**
     * Opens "start", writes `outside` over it (unless `null`: an SSE event that changed nothing new), and starts the
     * live reload whose read the vault answered and is held.
     */
    async function heldReload(outside: string | null = 'theirs\n') {
      const net = heldClient(app)
      session = new NoteSession(net.client)
      const note = await openNote('start\n')
      if (outside !== null) await writeFile(path.join(vault.root, note.id), outside)
      net.hold((url) => (url.pathname === '/api/notes/read' ? 'read' : undefined), { answered: true })
      const reload = session.externalChange()
      await vi.waitFor(() => expect(net.held).toHaveLength(1))
      const release = async () => {
        net.held[0]?.release()
        await reload
      }
      return { note, release }
    }

    it('keeps the text and hash of a save that worked, with no conflict, while it was out', async () => {
      const { note, release } = await heldReload(null)
      session.edit('mine\n')
      expect(await session.flush()).toBe(true)

      await release()
      const saved = await api.readNote(note.id)
      expect(session.body).toBe('mine\n')
      expect(session.note?.hash).toBe(saved.hash)
      expect(session.state).toBe('saved')
    })

    it('keeps the text and hash of a Keep mine save that worked while it was out', async () => {
      const { note, release } = await heldReload()
      session.edit('mine\n')
      await session.flush()
      expect(session.state).toBe('conflict')
      expect(await session.keepMine()).toEqual({ state: 'saved' })

      await release()
      const saved = await api.readNote(note.id)
      expect(saved.body).toBe('mine\n')
      expect(session.body).toBe('mine\n')
      expect(session.note?.hash).toBe(saved.hash)
      expect(session.state).toBe('saved')
    })

    it('keeps the newer disk version a conflicting save brought while it was out', async () => {
      const { note, release } = await heldReload()
      await writeFile(path.join(vault.root, note.id), 'newer\n')
      session.edit('mine\n')
      await session.flush()
      expect(session.theirs?.body).toBe('newer\n')

      await release()
      expect(session.state).toBe('conflict')
      expect(session.theirs?.body).toBe('newer\n')
    })

    it('keeps the note removed when the SSE note-removed event came while it was out', async () => {
      const { release } = await heldReload()
      session.externalRemoval()

      await release()
      expect(session.state).toBe('removed')
    })

    it('keeps the note removed when a save found it gone while it was out', async () => {
      const { note, release } = await heldReload()
      await api.renameNote(note.id, 'Elsewhere')
      session.edit('mine\n')
      await session.flush()
      expect(session.state).toBe('removed')

      await release()
      expect(session.state).toBe('removed')
    })
  })
})

describe('NoteSession.saveAsset', () => {
  const image = () => new File([new Uint8Array([1, 2, 3])], 'p.png', { type: 'image/png' })

  it('gives the image link for the note’s new place when it was renamed while the image was saved', async () => {
    const net = heldClient(app)
    session = new NoteSession(net.client)
    const note = await openNote('start\n')
    net.hold((url) => (url.pathname === '/api/assets' ? 'upload' : undefined))
    const saving = session.saveAsset(image())
    await vi.waitFor(() => expect(net.held).toHaveLength(1))
    const { note: renamed } = await api.renameNote(note.id, 'Renamed')
    session.relocated(renamed)
    net.hold(null)
    net.held[0]?.release()
    const href = await saving
    expect(href).toMatch(/^\.\/Renamed\.assets\/[0-9a-f]+\.png$/)
    expect(await readFile(path.join(vault.root, href))).toEqual(Buffer.from([1, 2, 3]))
  })

  it('does not save the image for another note opened while it was saved', async () => {
    const net = heldClient(app)
    session = new NoteSession(net.client)
    const note = await openNote('start\n')
    const other = await api.createNote('')
    net.hold((url) => (url.pathname === '/api/assets' ? 'upload' : undefined))
    const saving = session.saveAsset(image())
    await vi.waitFor(() => expect(net.held).toHaveLength(1))
    session.open(other)
    net.hold(null)
    net.held[0]?.release()
    expect(await saving).toMatch(new RegExp(`^\\./${note.id.replace(/\.md$/, '')}\\.assets/`))
    await expect(access(path.join(vault.root, `${other.id.replace(/\.md$/, '')}.assets`))).rejects.toThrow()
  })

  it('refuses with no note open, and when the note closed while the image was saved', async () => {
    const net = heldClient(app)
    session = new NoteSession(net.client)
    await expect(session.saveAsset(image())).rejects.toThrow('No note is open')
    await openNote('start\n')
    net.hold((url) => (url.pathname === '/api/assets' ? 'upload' : undefined))
    const saving = session.saveAsset(image())
    await vi.waitFor(() => expect(net.held).toHaveLength(1))
    session.close()
    net.held[0]?.release()
    await expect(saving).rejects.toThrow('No note is open')
  })

  it('refuses with a notice-ready message while the note is removed, writing no assets folder', async () => {
    const note = await openNote('start\n')
    await rm(path.join(vault.root, note.id))
    session.externalRemoval()
    await expect(session.saveAsset(image())).rejects.toThrow('Save your copy of the note first, then add the image')
    await expect(access(path.join(vault.root, `${note.id.replace(/\.md$/, '')}.assets`))).rejects.toThrow()
  })
})

describe('NoteSession with a scratch note', () => {
  /** A session over a client whose scratch writes are held (answered `held` until released). */
  async function heldScratchWrite() {
    const net = heldClient(app)
    session = new NoteSession(net.client)
    const scratch = await api.createScratch()
    session.openScratch(scratch)
    session.edit('text\n')
    net.hold((url) => (url.pathname === '/api/scratch/write' ? 'write' : undefined), { once: true })
    const flushing = session.flush()
    await vi.waitFor(() => expect(net.held).toHaveLength(1))
    return { net, flushing, scratch }
  }

  it('drops a scratch save that returns after the session closed', async () => {
    const { net, flushing } = await heldScratchWrite()
    session.close()
    net.held[0]?.release()
    await flushing
    expect(session.scratch).toBeNull()
    expect(session.state).toBe('saved')
    expect(session.error).toBe('')
  })

  it('drops a failure of a scratch save that returns after another scratch note opened', async () => {
    const { net, flushing } = await heldScratchWrite()
    const other = await api.createScratch()
    session.openScratch(other)
    net.held[0]?.release('Disk full')
    await flushing
    expect(session.scratch?.id).toBe(other.id)
    expect(session.state).toBe('saved')
    expect(session.error).toBe('')
  })
})
