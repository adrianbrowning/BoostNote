import { mkdir, stat, writeFile } from 'node:fs/promises'
import * as path from 'node:path'

import { exportFolderHtml, exportNoteMarkdown, noteToHtml } from '../../../markdown/index.ts'
import type { Vault } from '../../../vault/index.ts'
import { HttpError, json, readJsonObject, requireString } from '../../http.ts'
import type { AppServices } from '../../services.ts'
import type { ExportResult } from '../public/workspace/types.ts'

export const NOTE_EXPORT_FORMATS = ['html', 'pdf', 'markdown', 'print'] as const
export type NoteExportFormat = (typeof NOTE_EXPORT_FORMATS)[number]

const SAVE_FILTERS: Record<Exclude<NoteExportFormat, 'print'>, { name: string; extension: string }> = {
  html: { name: 'HTML', extension: 'html' },
  pdf: { name: 'PDF', extension: 'pdf' },
  markdown: { name: 'Markdown', extension: 'md' },
}

/** `<dir>/<name>`, or `<name> 2`, `<name> 3`… when that already exists. */
async function freePath(dir: string, name: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, n === 1 ? name : `${name} ${n}`)
    if (!(await stat(candidate).catch(() => undefined))) return candidate
  }
}

/** `POST /api/export/note {id, format}`: save dialog in main, then render and write (or print). */
export async function exportNote(services: AppServices, vault: Vault, request: Request): Promise<Response> {
  const body = await readJsonObject(request)
  const id = requireString(body.id, 'id')
  const format = NOTE_EXPORT_FORMATS.find((value) => value === body.format)
  if (!format) throw new HttpError(400, 'BAD_REQUEST', `Unknown export format: ${String(body.format)}`)
  const note = await vault.readNote(id)
  const { renderMermaid } = services.exports

  if (format === 'print') {
    await services.exports.print(await noteToHtml(vault, id, { renderMermaid }))
    return json({ path: null } satisfies ExportResult)
  }

  const filter = SAVE_FILTERS[format]
  const stem = path.posix.basename(id).replace(/\.md$/i, '')
  const target = await services.exports.saveFile({
    title: `Export as ${filter.name}`,
    defaultPath: `${stem}.${filter.extension}`,
    filters: [{ name: filter.name, extensions: [filter.extension] }],
  })
  if (target === undefined) return json({ path: null } satisfies ExportResult)
  if (path.resolve(target) === path.join(vault.root, ...id.split('/'))) {
    throw new HttpError(400, 'BAD_REQUEST', 'Choose a different file than the note itself')
  }
  if (format === 'markdown') {
    await exportNoteMarkdown(vault, note.id, target)
  } else {
    const html = await noteToHtml(vault, note.id, { renderMermaid })
    await writeFile(target, format === 'html' ? html : await services.exports.printToPdf(html))
  }
  return json({ path: target } satisfies ExportResult)
}

/** `POST /api/export/folder {folder}` (`''`: the vault): a new directory with `index.html` and one page per note. */
export async function exportFolder(services: AppServices, vault: Vault, request: Request): Promise<Response> {
  const body = await readJsonObject(request)
  const folder = requireString(body.folder, 'folder', { allowEmpty: true })
  if (folder !== '' && !vault.folders.includes(folder)) {
    throw new HttpError(404, 'NOT_FOUND', `Folder not found: ${folder}`)
  }
  const parent = await services.pickFolder({
    title: 'Export as HTML: choose where to create the folder',
    buttonLabel: 'Export',
    createDirectory: true,
  })
  if (parent === undefined) return json({ path: null } satisfies ExportResult)
  const name = folder === '' ? path.basename(vault.root) : path.posix.basename(folder)
  const target = await freePath(parent, `${name} (HTML)`)
  await mkdir(target)
  const { contents } = await exportFolderHtml(vault, folder, target, { renderMermaid: services.exports.renderMermaid })
  services.showItemInFolder(contents)
  return json({ path: target } satisfies ExportResult)
}
