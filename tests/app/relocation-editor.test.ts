// @vitest-environment happy-dom
import { undo } from '@codemirror/commands'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Client } from '../../src/app/actions/public/workspace/api.ts'
import { WorkspaceModel } from '../../src/app/actions/public/workspace/model.ts'
import { createLivePreviewEditor, type LivePreviewEditor } from '../../src/editor/index.ts'
import { DEFAULT_UI } from '../../src/main/settings.ts'
import { folderWith, heldClient, noTabStore, TestApp } from './helpers.ts'

/**
 * Moving the open note with the real editor wired to `WorkspaceModel`'s session as the editor pane wires it, over
 * the in-process router: the editor shows the links the vault rebased, and undo still works.
 */

let app: TestApp
let api: Client
let workspace: WorkspaceModel
let editor: LivePreviewEditor

beforeEach(async () => {
  app = await TestApp.create()
  api = heldClient(app).client
  await folderWith(app, 'vault', {
    'a.md': '# A\n\n[b](./b.md)\n\n[c](./c.md)\n',
    'b.md': '# B\n',
    'c.md': '# C\n',
    'g/x.md': '# X\n',
  })
  await app.openVault('vault')
  workspace = new WorkspaceModel(
    await api.workspace(),
    { ui: DEFAULT_UI, hotkeyRegistered: false, captureHotkeyRegistered: false, update: null },
    { api, store: noTabStore },
  )
  await workspace.openNote('a.md')
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

it('shows the links the vault rebased after a move of the open note, keeping the cursor, and undo still works', async () => {
  const at = '# A\n\n[b](./b.md)\n\n'.length
  editor.view.dispatch({
    changes: { from: at, insert: 'Typed.\n\n' },
    selection: { anchor: at + 'Typed.'.length },
    userEvent: 'input.type',
  })
  expect(await workspace.session.flush()).toBe(true)

  await workspace.moveNote('a.md', 'g')

  expect(workspace.session.note?.id).toBe('g/a.md')
  expect(editor.view.state.doc.toString()).toBe('# A\n\n[b](../b.md)\n\nTyped.\n\n[c](../c.md)\n')
  expect(editor.view.state.selection.main.head).toBe('# A\n\n[b](../b.md)\n\nTyped.'.length)
  undo(editor.view)
  expect(editor.view.state.doc.toString()).toBe('# A\n\n[b](../b.md)\n\n[c](../c.md)\n')
  expect(await workspace.session.flush()).toBe(true)
  expect((await api.readNote('g/a.md')).body).toBe('# A\n\n[b](../b.md)\n\n[c](../c.md)\n')
})
