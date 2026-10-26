// Smoke run of the real app on a COPY of a vault: `pnpm smoke --vault-copy <dir> [--steps <file>]
// [--shot <png>]`. The copy and a temp profile live in a temp folder that is kept for inspection;
// the source folder is only read. `--steps` is a module whose default export gets the launched
// app (`AppHandle` from tests/e2e/fixtures.ts: page, electronApp, vault, clickMenu, …).
import { mkdir } from 'node:fs/promises'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { type AppHandle, launchApp } from '../tests/e2e/fixtures.ts'

const { values } = parseArgs({
  options: {
    'vault-copy': { type: 'string' },
    steps: { type: 'string' },
    shot: { type: 'string' },
  },
})
const source = values['vault-copy']
if (!source) {
  console.error('Usage: pnpm smoke --vault-copy <dir> [--steps <file.ts>] [--shot <file.png>]')
  process.exit(2)
}

const app = await launchApp({}, { vaultCopyOf: source })
try {
  console.log(`Copy of ${source} open at ${app.vault} (profile ${app.userDataDir})`)
  if (values.steps) {
    // The steps file is named on the command line, so it can only be imported at run time.
    const steps: { default: (app: AppHandle) => Promise<void> } = await import(
      pathToFileURL(path.resolve(values.steps)).href
    )
    await steps.default(app)
  }
  if (values.shot) {
    await mkdir(path.dirname(path.resolve(values.shot)), { recursive: true })
    await app.page.screenshot({ path: values.shot })
    console.log(`Screenshot: ${values.shot}`)
  }
} finally {
  await app.electronApp.close()
}
