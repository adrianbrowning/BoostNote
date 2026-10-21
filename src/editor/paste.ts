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

/** `![name](path)` for an inserted asset; paths with spaces or parentheses use the `<…>` destination form. */
export function imageMarkdown(fileName: string, path: string): string {
  const alt = fileName.replace(/\.[^.]+$/, '').replace(/[[\]\\]/g, '')
  const destination = /[\s()<>]/.test(path) ? `<${path.replace(/[<>]/g, encodeURIComponent)}>` : path
  return `![${alt}](${destination})`
}

const addPending = StateEffect.define<{ id: number; pos: number }>()
const removePending = StateEffect.define<number>()

/** Insertion points of images still being saved, mapped through edits made meanwhile. */
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

/** Saves each image through the host and inserts `![…](path)` at `pos` (tracked while saving). */
async function insertImages(view: EditorView, files: readonly File[], pos: number): Promise<void> {
  const id = ++nextPendingId
  view.dispatch({ effects: addPending.of({ id, pos }) })
  try {
    const host = view.state.facet(editorHost)
    const links: string[] = []
    for (const file of files) links.push(imageMarkdown(file.name, await host.saveAsset(file)))
    const at = view.state.field(pendingImages).get(id)
    if (at === undefined) return
    const insert = links.join('\n')
    view.dispatch({
      changes: { from: at, insert },
      selection: { anchor: at + insert.length },
      effects: removePending.of(id),
      userEvent: 'input.paste',
      scrollIntoView: true,
    })
  } catch (error) {
    view.dispatch({ effects: removePending.of(id) })
    console.error('Saving image failed', error)
  }
}

const imageFiles = (list: FileList | null | undefined) =>
  [...(list ?? [])].filter((file) => file.type.startsWith('image/'))

const CODE_NODES = /^(?:FencedCode|CodeBlock|InlineCode|CodeText|BlockMath|InlineMath)$/

/** Paste/drop: image files go through `saveAsset`; rich HTML becomes markdown (plain text inside code). */
export const pasteAndDrop = [
  pendingImages,
  EditorView.domEventHandlers({
    paste(event, view) {
      const data = event.clipboardData
      if (!data) return false
      const images = imageFiles(data.files)
      if (images.length > 0) {
        event.preventDefault()
        const { from, to } = view.state.selection.main
        if (to > from) view.dispatch({ changes: { from, to }, userEvent: 'delete.cut' })
        void insertImages(view, images, from)
        return true
      }
      const html = data.getData('text/html')
      // Code editors put highlighted HTML on the clipboard; their plain text is what the user wants.
      if (!html || data.types.includes('vscode-editor-data')) return false
      for (
        let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(view.state.selection.main.head, -1);
        node;
        node = node.parent
      ) {
        if (CODE_NODES.test(node.name)) return false
      }
      const markdown = htmlToMarkdown(html)
      if (!markdown) return false
      event.preventDefault()
      view.dispatch(view.state.replaceSelection(markdown), { userEvent: 'input.paste', scrollIntoView: true })
      return true
    },
    drop(event, view) {
      const images = imageFiles(event.dataTransfer?.files)
      if (images.length === 0) return false
      event.preventDefault()
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head
      void insertImages(view, images, pos)
      return true
    },
  }),
]
