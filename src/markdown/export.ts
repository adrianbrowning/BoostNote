import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { lastSegment, type NoteMeta, noteStem, parentOf, splitNoteExtension } from '../shared/vault-ids.ts'
import type { Note, Vault } from '../vault/index.ts'
import { rewriteRelativeLinks } from '../vault/links.ts'
import { nameKey } from '../vault/names.ts'
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
  options: ExportOptions & { pages?: ReadonlyMap<string, string> },
): Promise<string> {
  const { raw } = await vault.readNote(note.id)
  const rendered = await renderMarkdown(raw, {
    resolveImage: (src) => inlineImage(vault, note.id, src),
    ...(options.pages ? { rewriteLink: (href: string) => noteLinkToHtml(note.id, href, options.pages) } : {}),
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
  return renderNotePage(vault, note, options)
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const encodeHref = (relPath: string) => relPath.split('/').map(encodeURIComponent).join('/')

/**
 * Exports a folder (`''`: the whole vault) as a static site into `targetDir`, plus a listing of
 * every page by folder. Each page sits at the note's path with `.html` in place of its `.md` (any
 * case). A page name that clashes with one already given out, with a folder a note sits in (a
 * vault folder `a.html/`), or with the reserved listing name (`index.html`, or `_contents.html`
 * when the folder has its own `index.md`; itself numbered past a folder of that name), gets the next free
 * ` N` suffix (` 2`, ` 3`...) in `vault.notes()` order. Clashes are compared by `nameKey` (letter
 * case and Unicode normalization ignored), so `A.md` and `a.md`, NFC and NFD `Café`, and
 * extension-case twins get distinct pages: `a.md`, `a.MD` → `a.html`, `a 2.html`; `_contents.md`
 * beside `index.md` → `_contents 2.html`. Links to an exported note point at its page; a link to
 * a note outside the export, or to a missing exact id, stays as written. Returns the listing's
 * path and the page count.
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
  // Page of each note as a vault id (`work/Plan.MD` → `work/Plan.html`). Names are compared by
  // `nameKey`, so pages stay distinct on case- or normalization-insensitive disks (`A.md`, `a.md`
  // → `A.html`, `a 2.html`). A numbered page skips names another note has as its own (`a 2.md`
  // keeps `a 2.html`), the folders the notes sit in (a vault folder `a.html/` pushes `a.md` to
  // `a 2.html`) and the listing's name, which is picked first and itself skips those folders and
  // the notes' own pages (a folder `index.html/` makes the listing `index 2.html`).
  const ownIndex = notes.some((note) => nameKey(note.id.slice(prefix.length)) === 'index.md')
  const own = new Set(notes.map((note) => nameKey(`${splitNoteExtension(note.id).base}.html`)))
  const pages = new Map<string, string>()
  const taken = new Set<string>()
  for (const note of notes) {
    for (let dir = parentOf(note.id); dir !== ''; dir = parentOf(dir)) taken.add(nameKey(dir))
  }
  const listingBase = ownIndex ? '_contents' : 'index'
  let listing = `${listingBase}.html`
  for (let n = 2; ; n++) {
    const key = nameKey(`${prefix}${listing}`)
    if (!taken.has(key) && !(n > 2 && own.has(key))) break
    listing = `${listingBase} ${n}.html`
  }
  taken.add(nameKey(`${prefix}${listing}`))
  for (const note of notes) {
    const base = splitNoteExtension(note.id).base
    let page = `${base}.html`
    for (let n = 2; taken.has(nameKey(page)) || (n > 2 && own.has(nameKey(page))); n++) page = `${base} ${n}.html`
    taken.add(nameKey(page))
    pages.set(note.id, page)
  }

  const byFolder = new Map<string, Array<{ href: string; title: string }>>()
  for (const note of notes) {
    const relHtml = (pages.get(note.id) as string).slice(prefix.length)
    const file = path.join(targetDir, ...relHtml.split('/'))
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, await renderNotePage(vault, note, { ...options, pages }))
    const group = parentOf(note.id.slice(prefix.length))
    byFolder.set(group, [...(byFolder.get(group) ?? []), { href: encodeHref(relHtml), title: note.title }])
  }

  const name = folder === '' ? path.basename(vault.root) : lastSegment(folder)
  let body = `<h1>${escapeHtml(name)}</h1>\n`
  for (const [group, pages] of [...byFolder].sort(([a], [b]) => a.localeCompare(b))) {
    if (group !== '') body += `<h2>${escapeHtml(group)}</h2>\n`
    body += `<ul>\n${pages.map((page) => `<li><a href="${escapeHtml(page.href)}">${escapeHtml(page.title)}</a></li>\n`).join('')}</ul>\n`
  }
  const contents = path.join(targetDir, listing)
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
