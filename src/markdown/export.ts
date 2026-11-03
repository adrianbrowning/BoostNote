import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { lastSegment, noteStem, parentOf } from '../shared/vault-ids.ts'
import type { Note, NoteMeta, Vault } from '../vault/index.ts'
import { rewriteRelativeLinks } from '../vault/links.ts'
import { htmlDocument } from './document.ts'
import { noteLinkToHtml, renderMarkdown } from './render.ts'

/** Image types inlined into exported HTML; other linked files keep their (relative) link. */
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
}

export interface ExportOptions {
  /** SVG of a mermaid diagram (the app renders them in a hidden window). */
  renderMermaid?(source: string): Promise<string>
}

/** What folder export needs from a vault; `Vault` satisfies it. */
export interface ExportVault {
  readonly root: string
  notes(): Promise<readonly Pick<NoteMeta, 'id' | 'title'>[]>
  readNote(id: string): Promise<Pick<Note, 'raw'>>
  assetPath(noteId: string, href: string): Promise<string>
}

/** `data:` URI of an image the note links to; `undefined` for non-images, missing files or links outside the vault. */
async function inlineImage(vault: ExportVault, noteId: string, src: string): Promise<string | undefined> {
  const type = IMAGE_TYPES[/\.([a-z0-9]+)(?:[?#].*)?$/i.exec(src)?.[1]?.toLowerCase() ?? '']
  if (!type) return undefined
  const file = await vault.assetPath(noteId, src)
  return `data:${type};base64,${(await readFile(file)).toString('base64')}`
}

async function renderNotePage(
  vault: ExportVault,
  note: Pick<NoteMeta, 'id' | 'title'>,
  options: ExportOptions & { linkNotes: boolean },
): Promise<string> {
  const { raw } = await vault.readNote(note.id)
  const rendered = await renderMarkdown(raw, {
    resolveImage: (src) => inlineImage(vault, note.id, src),
    ...(options.linkNotes ? { rewriteLink: noteLinkToHtml } : {}),
    ...(options.renderMermaid ? { renderMermaid: options.renderMermaid } : {}),
  })
  return htmlDocument({ title: note.title, body: rendered.html, math: rendered.hasMath })
}

/**
 * One note as a standalone HTML document: images inlined as `data:` URIs, math and diagrams
 * pre-rendered, no scripts. Also the input of PDF export and printing.
 */
export async function noteToHtml(vault: Vault, id: string, options: ExportOptions = {}): Promise<string> {
  const note = (await vault.findNote(id)) ?? (await vault.readNote(id))
  return renderNotePage(vault, note, { ...options, linkNotes: false })
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const encodeHref = (relPath: string) => relPath.split('/').map(encodeURIComponent).join('/')

/**
 * Exports a folder (`''`: the whole vault) as a static site into `targetDir`: one page per note at
 * the same relative path with `.html` instead of `.md`, links between notes rewritten to match, and
 * an `index.html` listing every page by folder. When the folder has its own `index.md`, that page is
 * `index.html` and the listing is `_contents.html`. Returns the listing's path and the page count.
 */
export async function exportFolderHtml(
  vault: ExportVault,
  folder: string,
  targetDir: string,
  options: ExportOptions = {},
): Promise<{ contents: string; pages: number }> {
  const prefix = folder === '' ? '' : `${folder}/`
  const notes = (await vault.notes()).filter((note) => note.id.startsWith(prefix))
  await mkdir(targetDir, { recursive: true })

  const byFolder = new Map<string, Array<{ href: string; title: string }>>()
  for (const note of notes) {
    const relId = note.id.slice(prefix.length)
    const relHtml = relId.replace(/\.md$/, '.html')
    const file = path.join(targetDir, ...relHtml.split('/'))
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, await renderNotePage(vault, note, { ...options, linkNotes: true }))
    const group = parentOf(relId)
    byFolder.set(group, [...(byFolder.get(group) ?? []), { href: encodeHref(relHtml), title: note.title }])
  }

  const name = folder === '' ? path.basename(vault.root) : lastSegment(folder)
  let body = `<h1>${escapeHtml(name)}</h1>\n`
  for (const [group, pages] of [...byFolder].sort(([a], [b]) => a.localeCompare(b))) {
    if (group !== '') body += `<h2>${escapeHtml(group)}</h2>\n`
    body += `<ul>\n${pages.map((page) => `<li><a href="${escapeHtml(page.href)}">${escapeHtml(page.title)}</a></li>\n`).join('')}</ul>\n`
  }
  const ownIndex = notes.some((note) => note.id.slice(prefix.length).toLowerCase() === 'index.md')
  const contents = path.join(targetDir, ownIndex ? '_contents.html' : 'index.html')
  await writeFile(contents, await htmlDocument({ title: name, body, math: false, className: 'index' }))
  return { contents, pages: notes.length }
}

/**
 * Copies a note's file to `targetFile` with its `<stem>.assets/` folder next to it (renamed after
 * the new file name, links rewritten to match). Other relative links are left as written.
 */
export async function exportNoteMarkdown(vault: Vault, id: string, targetFile: string): Promise<void> {
  const { raw } = await vault.readNote(id)
  const stem = noteStem(id)
  const targetStem = noteStem(targetFile)
  const assets = path.join(vault.root, ...parentOf(id).split('/'), `${stem}.assets`)
  const hasAssets = (await stat(assets).catch(() => undefined))?.isDirectory() ?? false
  const own = new RegExp(`^(\\./)?${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.assets/`)
  const text =
    hasAssets && targetStem !== stem
      ? rewriteRelativeLinks(raw, (relPath) =>
          own.test(relPath) ? relPath.replace(own, (_whole, dot = '') => `${dot}${targetStem}.assets/`) : undefined,
        )
      : raw
  await writeFile(targetFile, text)
  if (hasAssets) await cp(assets, path.join(path.dirname(targetFile), `${targetStem}.assets`), { recursive: true })
}
