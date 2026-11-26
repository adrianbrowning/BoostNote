import { syntaxTree } from '@codemirror/language'
import { StateEffect, StateField } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

import { editorHost } from './config.ts'

let turndown: TurndownService | undefined

/** Converts clipboard HTML (web pages, docs, mail) to GFM markdown: tables, task lists, strikethrough, fenced code. */
export function htmlToMarkdown(html: string): string {
  if (!turndown) {
    turndown = new TurndownService({
      headingStyle: 'atx',
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      emDelimiter: '*',
      strongDelimiter: '**',
      linkStyle: 'inlined',
    })
    turndown.use(gfm)
    turndown.remove(['script', 'style', 'meta', 'title', 'head'])
    // GFM `~~` (lezer only parses double tildes) instead of the plugin's single `~`.
    turndown.addRule('strikethrough', {
      filter: ['del', 's'],
      replacement: (content) => `~~${content}~~`,
    })
    // `- item` / `1. item` with one space (turndown pads markers to four columns), nested content
    // indented to the marker width, and `[x] text` without the double space a checkbox leaves behind.
    turndown.addRule('listItem', {
      filter: 'li',
      replacement(content, node) {
        const parent = node.parentNode as HTMLElement | null
        let marker = '- '
        if (parent?.nodeName === 'OL') {
          const start = Number(parent.getAttribute('start') ?? 1)
          marker = `${start + Array.prototype.indexOf.call(parent.children, node)}. `
        }
        const body = content
          .replace(/^\n+/, '')
          .replace(/\n+$/, '\n')
          .replace(/^(\[[ x]\]) +/, '$1 ')
          .replace(/\n/gm, `\n${' '.repeat(marker.length)}`)
        return marker + body + (node.nextSibling && !body.endsWith('\n') ? '\n' : '')
      },
    })
  }
  return turndown.turndown(html).trim()
}

/** A link destination; paths with spaces, parentheses or angle brackets use the `<…>` form. */
const destination = (path: string) => (/[\s()<>]/.test(path) ? `<${path.replace(/[<>]/g, encodeURIComponent)}>` : path)

/** `![name](path)` for an inserted asset. */
export function imageMarkdown(fileName: string, path: string): string {
  const alt = fileName.replace(/\.[^.]+$/, '').replace(/[[\]\\]/g, '')
  return `![${alt}](${destination(path)})`
}

const addPending = StateEffect.define<{ id: number; pos: number }>()
const removePending = StateEffect.define<number>()

/** Pending insertion points (images being picked or saved, a /table size being picked), mapped through edits made meanwhile. */
const pendingImages = StateField.define<ReadonlyMap<number, number>>({
  create: () => new Map(),
  update(pending, tr) {
    let next: Map<number, number> | undefined
    if (tr.docChanged && pending.size > 0) {
      next = new Map([...pending].map(([id, pos]) => [id, tr.changes.mapPos(pos, 1)]))
    }
    for (const effect of tr.effects) {
      if (effect.is(addPending)) {
        next ??= new Map(pending)
        next.set(effect.value.id, effect.value.pos)
      } else if (effect.is(removePending)) {
        next ??= new Map(pending)
        next.delete(effect.value)
      }
    }
    return next ?? pending
  },
})

let nextPendingId = 0

/** Per view, what waits for the editor to take edits again (`whenEditable`). */
const editableWaiters = new WeakMap<EditorView, Array<() => void>>()

/** Wakes the waiters of a view once it is no longer read-only. */
const wakeWhenEditable = EditorView.updateListener.of((update) => {
  if (update.state.readOnly) return
  const waiters = editableWaiters.get(update.view)
  if (!waiters) return
  editableWaiters.delete(update.view)
  for (const wake of waiters) wake()
})

/** Where a pending insertion goes (`trackInsertion`): a pasted/dropped or /image image, or a /table grid. */
export interface PendingInsertion {
  at(): number | undefined
  whenEditable(): Promise<number | undefined>
  done(): void
}

/**
 * Tracks `pos` while an image is picked or saved or a /table size is picked, through edits made meanwhile. `at()` is where it is now, or
 * `undefined` once the document was replaced (another note): then nothing is saved or inserted. While the editor
 * is read-only (a transition holds the note) `whenEditable()` waits until it takes edits again, then gives `at()`.
 * `done()` stops tracking.
 */
export function trackInsertion(view: EditorView, pos: number): PendingInsertion {
  const id = ++nextPendingId
  view.dispatch({ effects: addPending.of({ id, pos }) })
  const at = () => view.state.field(pendingImages, false)?.get(id)
  return {
    at,
    async whenEditable() {
      while (view.state.readOnly && at() !== undefined) {
        const { promise, resolve } = Promise.withResolvers<void>()
        editableWaiters.set(view, [...(editableWaiters.get(view) ?? []), resolve])
        await promise
      }
      return at()
    },
    done: () => view.dispatch({ effects: removePending.of(id) }),
  }
}

/**
 * Saves `files` through the host (tracked at `target`), waits until the editor takes edits, then calls `insert` with
 * the position (`target.at()`) and the images' note-relative paths, in the same step as the last check (nothing
 * runs in between, so the editor is still editable). An image whose place changed while it was pending
 * (`EditorHost.assetPlace`: the note was renamed or moved) is saved again for the new place first, so its link
 * fits where the note is. Nothing is inserted once the document was replaced (another note).
 */
export async function insertSavedImages(
  view: EditorView,
  target: PendingInsertion,
  files: readonly File[],
  insert: (at: number, paths: string[]) => void,
): Promise<void> {
  const host = view.state.facet(editorHost)
  const saved: Array<{ place: string | undefined; path: string }> = []
  for (;;) {
    for (const [index, file] of files.entries()) {
      if (saved[index] !== undefined && saved[index].place === host.assetPlace()) continue
      // Editable: the save starts right away (no await); read-only: it waits until the editor takes edits.
      if ((view.state.readOnly ? await target.whenEditable() : target.at()) === undefined) return
      const place = host.assetPlace()
      saved[index] = { place, path: await host.saveAsset(file) }
    }
    // Wait out read-only periods (a relocation may land in one), then check the places right before the insert.
    while (view.state.readOnly && (await target.whenEditable()) !== undefined) {}
    const at = target.at()
    if (at === undefined) return
    if (saved.every((entry) => entry.place === host.assetPlace())) {
      insert(
        at,
        saved.map((entry) => entry.path),
      )
      return
    }
  }
}

/** Saves each image through the host and inserts `![…](path)` at `pos` (tracked while saving; see `insertSavedImages`). */
async function insertImages(view: EditorView, files: readonly File[], pos: number): Promise<void> {
  const target = trackInsertion(view, pos)
  try {
    await insertSavedImages(view, target, files, (at, paths) => {
      const insert = paths.map((path, index) => imageMarkdown(files[index]?.name ?? '', path)).join('\n')
      view.dispatch({
        changes: { from: at, insert },
        selection: { anchor: at + insert.length },
        userEvent: 'input.paste',
        scrollIntoView: true,
      })
    })
  } catch (error) {
    console.error('Saving image failed', error)
  } finally {
    target.done()
  }
}

const imageFiles = (list: FileList | null | undefined) =>
  [...(list ?? [])].filter((file) => file.type.startsWith('image/'))

const CODE_NODES = /^(?:FencedCode|CodeBlock|InlineCode|CodeText|BlockMath|InlineMath)$/
/** Where a pasted URL stays as typed: code, and inside a link or image (its text or destination). */
const PLAIN_URL_NODES = /^(?:Link|Image|Autolink|URL)$/

/** The innermost syntax node names around `pos`, innermost first. */
function nodeNamesAt(view: EditorView, pos: number): string[] {
  const names: string[] = []
  for (let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, -1); node; node = node.parent) {
    names.push(node.name)
  }
  return names
}

/**
 * Paste/drop: image files go through `saveAsset`; a lone URL becomes `![](url)`; rich HTML becomes markdown (plain
 * text inside code). A read-only editor takes neither, and starts no image save; a save that is out when the
 * editor goes read-only inserts its image once it is editable again (nothing when the note was replaced).
 */
export const pasteAndDrop = [
  pendingImages,
  wakeWhenEditable,
  EditorView.domEventHandlers({
    paste(event, view) {
      if (view.state.readOnly) {
        event.preventDefault()
        return true
      }
      const data = event.clipboardData
      if (!data) return false
      const images = imageFiles(data.files)
      if (images.length > 0) {
        event.preventDefault()
        const { from, to } = view.state.selection.main
        // With nowhere to store images (`assetPlace` undefined: a scratch note), the save is refused: keep the selection.
        if (to > from && view.state.facet(editorHost).assetPlace() !== undefined) {
          view.dispatch({ changes: { from, to }, userEvent: 'delete.cut' })
        }
        void insertImages(view, images, from)
        return true
      }
      const { from, to } = view.state.selection.main
      const names = nodeNamesAt(view, from)
      if (names.some((name) => CODE_NODES.test(name))) return false
      const url = data.getData('text/plain').trim()
      if (/^https?:\/\/\S+$/i.test(url) && !names.some((name) => PLAIN_URL_NODES.test(name))) {
        event.preventDefault()
        const alt = view.state.sliceDoc(from, to).replace(/[[\]\\]/g, '\\$&')
        const markdown = `![${alt}](${destination(url)})`
        // No alt text yet: leave the cursor between the brackets to type it.
        const cursor = from + (alt ? markdown.length : 2)
        view.dispatch({
          changes: { from, to, insert: markdown },
          selection: { anchor: cursor },
          userEvent: 'input.paste',
          scrollIntoView: true,
        })
        return true
      }
      const html = data.getData('text/html')
      // Code editors put highlighted HTML on the clipboard; their plain text is what the user wants.
      if (!html || data.types.includes('vscode-editor-data')) return false
      const markdown = htmlToMarkdown(html)
      if (!markdown) return false
      event.preventDefault()
      view.dispatch(view.state.replaceSelection(markdown), { userEvent: 'input.paste', scrollIntoView: true })
      return true
    },
    drop(event, view) {
      if (view.state.readOnly) {
        event.preventDefault()
        return true
      }
      const images = imageFiles(event.dataTransfer?.files)
      if (images.length === 0) return false
      event.preventDefault()
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head
      void insertImages(view, images, pos)
      return true
    },
  }),
]
