import type { WorkspaceModel } from './model.ts'

declare global {
  interface Window {
    /** Exposed by the preload (`src/main/preload.cjs`): a one-time import ticket for dropped `File`s. */
    boostnote?: { grantDroppedFiles(files: File[]): Promise<DropTicket> }
  }
}

export interface DropTicket {
  ticket: string
  /** How many dropped items are files or folders on disk. */
  count: number
}

/** True when a drag carries files from the OS (not one of the app's own note/folder/tab drags). */
export function carriesFiles(data: DataTransfer | null | undefined): boolean {
  return data?.types.includes('Files') ?? false
}

/** Copies the files of an OS drop into `folder` (`model.importDropped`, with a ticket from the preload). */
export function importDrop(model: WorkspaceModel, data: DataTransfer, folder: string): void {
  const files = [...data.files]
  void (window.boostnote?.grantDroppedFiles(files) ?? Promise.resolve(undefined)).then(
    (drop) => model.importDropped(drop, folder),
    (error: unknown) => model.notify('error', error instanceof Error ? error.message : String(error)),
  )
}

/**
 * Makes the whole window a drop target for `.md` files and folders from the OS: they go to the
 * folder selected in the sidebar (folder rows handle their own drops). Runs in the capture phase so
 * the editor never inserts a dropped note's text; drops of nothing but images onto the editor text
 * are left to the editor, which stores them as assets.
 */
export function installDropImport(model: WorkspaceModel, signal: AbortSignal): void {
  window.addEventListener(
    'dragover',
    (event) => {
      if (!carriesFiles(event.dataTransfer)) return
      // Without this Chromium would open the file in place of the app.
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    },
    { signal, capture: true },
  )
  window.addEventListener(
    'drop',
    (event) => {
      const data = event.dataTransfer
      if (!data || !carriesFiles(data)) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('[data-folder]')) return
      const files = [...data.files]
      if (target?.closest('.cm-editor') && files.length > 0 && files.every((file) => file.type.startsWith('image/'))) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      importDrop(model, data, model.dropFolder)
    },
    { signal, capture: true },
  )
}
