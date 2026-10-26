import * as path from 'node:path'
import { parseArgs } from 'node:util'

import { MigrationError } from './legacy.ts'
import { type MigrationReport, migrateStorage } from './migrate.ts'

const USAGE = `Usage: pnpm migrate <legacyStorageDir> <targetVaultDir> [--force] [--dry-run]

Converts a legacy Boostnote storage (boostnote.json + notes/*.cson) into a folder of markdown
notes. The legacy storage is only read, never modified.

  --force     write into a target folder that already contains files (nothing is overwritten)
  --dry-run   show what would be converted without writing anything
  --help      show this help`

function printSummary(report: MigrationReport): void {
  const { counts } = report
  console.log(`${report.dryRun ? 'Dry run — nothing written.\n' : ''}Source: ${report.source}`)
  console.log(`Target: ${report.target}`)
  console.log(
    `Folders: ${counts.folders}  Notes: ${counts.notes} (${counts.markdownNotes} markdown, ${counts.snippetNotes} snippet, ${counts.trashedNotes} in trash)`,
  )
  console.log(`Attachments: ${counts.attachments}  Note links: ${counts.noteLinks}`)
  const issues: Array<[string, string[]]> = [
    ['Renamed', report.renamed.map((item) => `${item.kind} "${item.name}" → ${item.path} (${item.reason})`)],
    ['Unresolved attachments', report.unresolvedAttachments.map((item) => `${item.note}: ${item.reference}`)],
    ['Unresolved note links', report.unresolvedLinks.map((item) => `${item.note}: ${item.reference}`)],
    ['Skipped (unreadable) notes', report.skipped.map((item) => `${item.file}: ${item.reason}`)],
    ['Warnings', report.warnings],
  ]
  for (const [title, lines] of issues) {
    if (lines.length === 0) continue
    console.log(`\n${title} (${lines.length}):`)
    for (const line of lines) console.log(`  - ${line}`)
  }
  if (!report.dryRun) console.log(`\nReport: ${path.join(report.target, '.boostnote', 'migration-report.json')}`)
}

interface CliArgs {
  source?: string
  target?: string
  extra: string[]
  force: boolean
  dryRun: boolean
  help: boolean
}

function parseCliArgs(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      force: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const [source, target, ...extra] = positionals
  return { source, target, extra, force: values.force, dryRun: values['dry-run'], help: values.help }
}

async function main(argv: string[]): Promise<number> {
  let args: CliArgs
  try {
    args = parseCliArgs(argv)
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    return 2
  }
  if (args.help) {
    console.log(USAGE)
    return 0
  }
  const { source, target } = args
  if (!source || !target || args.extra.length > 0) {
    console.error(USAGE)
    return 2
  }
  try {
    printSummary(await migrateStorage(source, target, { force: args.force, dryRun: args.dryRun }))
    return 0
  } catch (error) {
    if (error instanceof MigrationError) {
      console.error(`Error: ${error.message}`)
      return 1
    }
    throw error
  }
}

process.exitCode = await main(process.argv.slice(2))
