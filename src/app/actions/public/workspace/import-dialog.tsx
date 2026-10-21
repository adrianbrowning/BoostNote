import type { Handle } from 'remix/component'
import { css, on } from 'remix/component'

import { client } from './api.ts'
import type { WorkspaceModel } from './model.ts'
import { button, input, muted, primaryButton } from './styles.ts'
import type { ImportCandidate, ImportSummary } from './types.ts'

/**
 * "Import Boostnote Storage…": pick a legacy storage (storages found on this machine are offered as
 * buttons) and a target folder, preview the conversion (dry run), run it, then open the new vault.
 * Found storages are never written into the field in the background: a late write would merge with
 * what the user is typing or pasting at that moment.
 */
export function ImportDialog(handle: Handle<{ model: WorkspaceModel }>) {
  let candidates: ImportCandidate[] = []
  let source = ''
  let target = ''
  let force = false
  let busy = false
  let error = ''
  let preview: ImportSummary | null = null
  let result: ImportSummary | null = null

  handle.queueTask(async (signal) => {
    try {
      candidates = await client.importCandidates()
      if (signal.aborted) return
      void handle.update()
    } catch {
      // Detection is a convenience; the user can still choose a folder.
    }
  })

  const edited = (update: () => void) => {
    update()
    preview = null
    error = ''
    void handle.update()
  }

  const pick = async (purpose: 'source' | 'target') => {
    try {
      const { path } = await client.pickImportFolder(purpose)
      if (path === null) return
      edited(() => {
        if (purpose === 'source') source = path
        else target = path
      })
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
      void handle.update()
    }
  }

  const run = async (dryRun: boolean) => {
    busy = true
    error = ''
    void handle.update()
    try {
      const summary = await client.runImport({ source, target, dryRun, force })
      if (dryRun) preview = summary
      else result = summary
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    busy = false
    void handle.update()
  }

  const close = () => handle.props.model.setImportOpen(false)

  const summaryView = (summary: ImportSummary) => {
    const { counts } = summary
    return (
      <div mix={summaryStyle} data-import-summary={summary.dryRun ? 'preview' : 'done'}>
        <p>
          <strong>{summary.dryRun ? 'Will import' : 'Imported'}</strong> {counts.notes} notes ({counts.markdownNotes}{' '}
          markdown, {counts.snippetNotes} snippet, {counts.trashedNotes} in trash) in {counts.folders} folders,{' '}
          {counts.attachments} attachments and {counts.noteLinks} note links.
        </p>
        {summary.renamed + summary.unresolvedAttachments + summary.unresolvedLinks + counts.skippedNotes > 0 ? (
          <ul mix={issuesStyle}>
            {summary.renamed > 0 ? <li>{summary.renamed} folders/notes get a different file name</li> : null}
            {summary.unresolvedAttachments > 0 ? (
              <li>{summary.unresolvedAttachments} attachment links point to missing files</li>
            ) : null}
            {summary.unresolvedLinks > 0 ? <li>{summary.unresolvedLinks} note links point to missing notes</li> : null}
            {counts.skippedNotes > 0 ? <li>{counts.skippedNotes} unreadable notes are skipped</li> : null}
          </ul>
        ) : null}
        {summary.warnings.length > 0 ? (
          <details>
            <summary>{summary.warnings.length} warnings</summary>
            <ul mix={issuesStyle}>
              {summary.warnings.map((warning, index) => (
                <li key={`w-${index}`}>{warning}</li>
              ))}
            </ul>
          </details>
        ) : null}
        {summary.reportPath ? <p mix={muted}>Full report: {summary.reportPath}</p> : null}
      </div>
    )
  }

  return () => {
    const { model } = handle.props
    const ready = source.trim() !== '' && target.trim() !== '' && !busy
    return (
      <div mix={scrimStyle} role="dialog" aria-modal="true" aria-label="Import Boostnote storage">
        <form
          mix={[
            dialogStyle,
            on('keydown', (event) => {
              if (event.key === 'Escape' && !busy) close()
            }),
            on('submit', (event) => {
              event.preventDefault()
              if (ready && !result) void run(preview === null)
            }),
          ]}
        >
          <h2 mix={titleStyle}>Import Boostnote storage</h2>
          <p mix={muted}>
            Converts a legacy Boostnote storage into a new vault of Markdown files. The storage itself is only read.
          </p>
          <label mix={fieldStyle}>
            <span>Boostnote storage folder</span>
            <span mix={rowStyle}>
              <input
                name="source"
                value={source}
                disabled={result !== null}
                mix={[input, on('input', (event) => edited(() => (source = event.currentTarget.value)))]}
              />
              <button type="button" disabled={result !== null} mix={[button, on('click', () => void pick('source'))]}>
                Choose…
              </button>
            </span>
            {candidates.length > 0 && result === null ? (
              <span mix={rowStyle} data-import-candidates>
                <span mix={muted}>Found:</span>
                {candidates.map((candidate) => (
                  <button
                    key={candidate.path}
                    type="button"
                    title={candidate.path}
                    aria-pressed={source === candidate.path ? 'true' : 'false'}
                    data-import-candidate={candidate.path}
                    mix={[button, on('click', () => edited(() => (source = candidate.path)))]}
                  >
                    {candidate.name ?? candidate.path}
                  </button>
                ))}
              </span>
            ) : null}
          </label>
          <label mix={fieldStyle}>
            <span>New vault folder</span>
            <span mix={rowStyle}>
              <input
                name="target"
                value={target}
                disabled={result !== null}
                mix={[input, on('input', (event) => edited(() => (target = event.currentTarget.value)))]}
              />
              <button type="button" disabled={result !== null} mix={[button, on('click', () => void pick('target'))]}>
                Choose…
              </button>
            </span>
          </label>
          <label mix={checkboxStyle}>
            <input
              type="checkbox"
              name="force"
              checked={force}
              disabled={result !== null}
              mix={on('change', (event) => edited(() => (force = event.currentTarget.checked)))}
            />
            <span>Allow a folder that already contains files (nothing is overwritten)</span>
          </label>
          {error ? (
            <p role="alert" mix={errorStyle}>
              {error}
            </p>
          ) : null}
          {result ? summaryView(result) : preview ? summaryView(preview) : null}
          <div mix={actionsStyle}>
            {result ? (
              <>
                <button type="button" mix={[button, on('click', close)]}>
                  Close
                </button>
                <button
                  type="button"
                  mix={[button, primaryButton, on('click', () => void model.openVault(result?.target ?? target))]}
                  data-open-imported
                >
                  Open vault
                </button>
              </>
            ) : (
              <>
                <button type="button" disabled={busy} mix={[button, on('click', close)]}>
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!ready}
                  mix={[button, on('click', () => void run(true))]}
                  data-import-preview
                >
                  Preview
                </button>
                <button
                  type="button"
                  disabled={!ready || preview === null}
                  mix={[button, primaryButton, on('click', () => void run(false))]}
                  data-import-run
                  title={preview === null ? 'Preview the import first' : undefined}
                >
                  {busy ? 'Working…' : 'Import'}
                </button>
              </>
            )}
          </div>
        </form>
      </div>
    )
  }
}

const scrimStyle = css({
  position: 'fixed',
  inset: 0,
  zIndex: 45,
  display: 'grid',
  placeItems: 'center',
  background: 'var(--bg-overlay)',
})

const dialogStyle = css({
  display: 'grid',
  gap: '12px',
  width: 'min(560px, calc(100vw - 32px))',
  maxHeight: 'calc(100vh - 32px)',
  overflow: 'auto',
  padding: '18px',
  border: '1px solid var(--border)',
  borderRadius: '10px',
  background: 'var(--bg)',
  boxShadow: 'var(--shadow)',
})

const titleStyle = css({ fontSize: '16px', fontWeight: 600 })

const fieldStyle = css({ display: 'grid', gap: '4px', fontSize: '12px' })

const rowStyle = css({ display: 'flex', gap: '6px' })

const checkboxStyle = css({ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' })

const errorStyle = css({ color: 'var(--danger)' })

const summaryStyle = css({
  display: 'grid',
  gap: '6px',
  padding: '10px 12px',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  background: 'var(--bg-list)',
  fontSize: '13px',
})

const issuesStyle = css({ margin: 0, paddingLeft: '18px' })

const actionsStyle = css({ display: 'flex', justifyContent: 'flex-end', gap: '8px' })
