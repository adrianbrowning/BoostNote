// @vitest-environment happy-dom
import { readdir, readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Client } from '../../src/app/actions/public/workspace/api.ts'
import { WorkspaceModel } from '../../src/app/actions/public/workspace/model.ts'
import { createLivePreviewEditor, type LivePreviewEditor } from '../../src/editor/index.ts'
import { DEFAULT_UI } from '../../src/main/settings.ts'
import { folderWith, type HeldClient, heldClient, noTabStore, TestApp } from './helpers.ts'

/**
 * An image pasted into the editor while the open note is renamed: the real editor (paste, `trackInsertion`) wired
 * to `WorkspaceModel`'s session as the editor pane wires it, over the in-process router.
 */

let app: TestApp
let net: HeldClient
let api: Client
let root: string
let workspace: WorkspaceModel
let editor: LivePreviewEditor

beforeEach(async () => {
  app = await TestApp.create()
  net = heldClient(app)
  api = net.client
  root = await folderWith(app, 'vault', { 'in first.md': '# In first\n' })
  await app.openVault('vault')
  workspace = new WorkspaceModel(
    await api.workspace(),
    { ui: DEFAULT_UI, hotkeyRegistered: false, captureHotkeyRegistered: false, update: null },
    { api, store: noTabStore },
  )
  await workspace.openNote('in first.md')
  const session = workspace.session
  const parent = document.createElement('div')
  document.body.append(parent)
  editor = createLivePreviewEditor({
    parent,
    doc: session.body,
    theme: 'light',
    onChange: (doc) => session.edit(doc),
    resolveAssetUrl: (relPath) => relPath,
    saveAsset: (file) => session.saveAsset(file),
    assetPlace: () => session.note?.id,
    onOpenLink: () => {},
  })
  session.addEventListener('doc', (event) => editor.setDoc(event.body, { preserveSelection: event.preserveSelection }))
  session.addEventListener('change', () => editor.setReadOnly(session.locked))
})

afterEach(async () => {
  editor.destroy()
  workspace.session.close()
  await app.close()
})

function pasteImage(): void {
  editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } })
  const data = new DataTransfer()
  data.items.add(new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' }))
  editor.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, cancelable: true }))
}

describe('an image pasted while the open note is renamed', () => {
  const held = (id: string) => net.held.find((request) => request.id === id)
  const linked = /!\[shot\]\((\.\/renamed\.assets\/[0-9a-f]+\.png)\)$/

  beforeEach(() => {
    net.hold((url) =>
      url.pathname === '/api/assets' || url.pathname === '/api/notes/rename' ? url.pathname : undefined,
    )
  })

  /** Pastes the image, then renames the open note through the model; both requests are held. */
  async function pasteThenRename(): Promise<{ renaming: Promise<string | null> }> {
    pasteImage()
    await expect.poll(() => net.held.length).toBe(1)
    const renaming = workspace.renameOpenNote('renamed')
    await expect.poll(() => net.held.length).toBe(2)
    net.hold(null)
    return { renaming }
  }

  async function expectLinkedIntoRenamedFolder(): Promise<void> {
    await vi.waitFor(() => expect(editor.view.state.doc.toString()).toMatch(linked))
    const href = linked.exec(editor.view.state.doc.toString())?.[1] ?? ''
    expect(await readFile(path.join(root, href))).toEqual(Buffer.from([1, 2, 3]))
  }

  it('is inserted with a link into the new assets folder when the rename lands before the image is saved', async () => {
    const { renaming } = await pasteThenRename()
    held('/api/notes/rename')?.release()
    expect(await renaming).toBeNull()
    held('/api/assets')?.release()
    await expectLinkedIntoRenamedFolder()
    // The upload for the old name was refused: no assets folder is left where the note no longer is.
    expect((await readdir(root)).sort()).toEqual(['renamed.assets', 'renamed.md'])
  })

  it('is inserted with a link into the new assets folder when the rename lands after the image was saved', async () => {
    const { renaming } = await pasteThenRename()
    // The image is saved for the old name while the rename is out (the editor is read-only): its insert waits.
    held('/api/assets')?.release()
    await expect.poll(() => readdir(path.join(root, 'in first.assets')).catch(() => [])).toHaveLength(1)
    held('/api/notes/rename')?.release()
    expect(await renaming).toBeNull()
    await expectLinkedIntoRenamedFolder()
  })

  it('saves again only the image saved for the old name when two are pasted, and inserts both in order', async () => {
    editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } })
    const data = new DataTransfer()
    data.items.add(new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }))
    data.items.add(new File([new Uint8Array([2])], 'b.png', { type: 'image/png' }))
    editor.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, cancelable: true }))
    await expect.poll(() => net.held.length).toBe(1)
    const renaming = workspace.renameOpenNote('renamed')
    await expect.poll(() => net.held.length).toBe(2)
    // a.png is saved for the old name while the rename is out; b.png waits until the editor takes edits again.
    held('/api/assets')?.release()
    await expect.poll(() => readdir(path.join(root, 'in first.assets')).catch(() => [])).toHaveLength(1)
    held('/api/notes/rename')?.release()
    expect(await renaming).toBeNull()
    // Then b.png, for the new name, and a.png again for it: two more uploads, no third.
    for (const count of [3, 4]) {
      await expect.poll(() => net.held.length).toBe(count)
      net.held[count - 1]?.release()
    }
    const links = /!\[a\]\(\.\/renamed\.assets\/([0-9a-f]+\.png)\)\n!\[b\]\(\.\/renamed\.assets\/([0-9a-f]+\.png)\)$/
    await vi.waitFor(() => expect(editor.view.state.doc.toString()).toMatch(links))
    const [, a, b] = links.exec(editor.view.state.doc.toString()) ?? []
    expect(await readFile(path.join(root, 'renamed.assets', a ?? ''))).toEqual(Buffer.from([1]))
    expect(await readFile(path.join(root, 'renamed.assets', b ?? ''))).toEqual(Buffer.from([2]))
    expect(net.held).toHaveLength(4)
  })
})

describe('an image pasted while the open note’s folder is moved', () => {
  it('is linked at the note’s new place once the move landed first, and the old folder is not made again', async () => {
    await api.createFolder('', 'f')
    await api.createFolder('', 'g')
    const note = await api.createNote('f')
    await workspace.openNote(note.id)
    net.hold((url) =>
      url.pathname === '/api/assets' || url.pathname === '/api/folders/move' ? url.pathname : undefined,
    )
    pasteImage()
    await expect.poll(() => net.held.length).toBe(1)
    const moving = workspace.moveFolder('f', 'g')
    await expect.poll(() => net.held.length).toBe(2)
    net.hold(null)
    net.held.find((request) => request.id === '/api/folders/move')?.release()
    await moving
    expect(workspace.session.note?.id).toBe(`g/${note.id}`)
    net.held.find((request) => request.id === '/api/assets')?.release()
    const linked = /!\[shot\]\((\.\/Untitled\.assets\/[0-9a-f]+\.png)\)$/
    await vi.waitFor(() => expect(editor.view.state.doc.toString()).toMatch(linked))
    const href = linked.exec(editor.view.state.doc.toString())?.[1] ?? ''
    expect(await readFile(path.join(root, 'g/f', href))).toEqual(Buffer.from([1, 2, 3]))
    expect(await readdir(root)).not.toContain('f')
  })
})
