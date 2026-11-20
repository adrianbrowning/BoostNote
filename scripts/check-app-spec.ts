// Fails when tests/e2e/app.spec.ts holds more tests than CAP: CODING_STANDARDS.md keeps app.spec.ts from
// growing, and a new e2e test joins the spec for its concern or starts a new one. Run by `pnpm run check`.
// Usage: node scripts/check-app-spec.ts [spec path]; the path defaults to tests/e2e/app.spec.ts.
// Lower CAP when a test moves out of app.spec.ts; never raise it.
import { readFileSync } from 'node:fs'
import path from 'node:path'

const CAP = 30

const spec = process.argv[2] ?? path.resolve(import.meta.dirname, '../tests/e2e/app.spec.ts')
// Counts test declarations at any depth (top level and inside test.describe), so wrapping a test does not dodge the cap.
const count = readFileSync(spec, 'utf8').match(/^\s*test(\.(only|skip|fixme|fail|slow))?\(/gm)?.length ?? 0

if (count > CAP) {
  console.error(
    `${spec} has ${count} tests, over its cap of ${CAP}. Do not grow app.spec.ts: add a spec for its concern ` +
      '(styles.spec.ts, layout.spec.ts, csp.spec.ts, …) or start a new one in tests/e2e/.',
  )
  process.exit(1)
}
