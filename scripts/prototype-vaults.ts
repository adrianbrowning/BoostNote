// PROTOTYPE (branch prototype/multi-vault): `pnpm prototype:vaults [--variant A|B|C] [--shots <dir>]`.
// Opens the real app on a temp vault and profile, then shows the multi-vault variants (stub data).
// With --shots it saves one screenshot per variant and exits; without, it waits until you close it.
import { mkdir, rm } from 'node:fs/promises'
import * as path from 'node:path'
import { parseArgs } from 'node:util'

import { launchApp } from '../tests/e2e/fixtures.ts'

const { values } = parseArgs({ options: { variant: { type: 'string' }, shots: { type: 'string' } } })
const app = await launchApp({ 'Welcome.md': '# Prototype vault\n' })
try {
  await app.page.goto(`boost://app/prototype/vaults?variant=${values.variant ?? 'A'}`)
  await app.page.locator('[data-prototype-switcher]').waitFor()
  if (values.shots) {
    const dir = path.resolve(values.shots)
    await mkdir(dir, { recursive: true })
    for (const key of ['A', 'B', 'C']) {
      await app.page.goto(`boost://app/prototype/vaults?variant=${key}`)
      await app.page.locator(`[data-variant="${key}"]`).waitFor()
      await app.page.screenshot({ path: path.join(dir, `variant-${key}.png`) })
    }
    console.log(`Screenshots in ${dir}`)
  } else {
    console.log('Prototype open: ← / → or the bottom bar switch variants. Close the window to quit.')
    const closed = Promise.withResolvers<void>()
    app.electronApp.on('close', () => closed.resolve())
    await closed.promise
  }
} finally {
  await app.electronApp.close().catch(() => {})
  await rm(app.dir, { recursive: true, force: true })
}
