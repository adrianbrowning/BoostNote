// Fails when tests/e2e/app.spec.ts holds more tests than its caps: CODING_STANDARDS.md keeps app.spec.ts from
// growing, and a new e2e test joins the spec for its concern or starts a new one. Run by `pnpm run check`.
// Usage: node scripts/check-app-spec.ts [spec path]; the path defaults to tests/e2e/app.spec.ts.
// Lower a cap when a test moves out of app.spec.ts; never raise one.
import { readFileSync } from 'node:fs'
import path from 'node:path'

const TOP_LEVEL_CAP = 27
// Every test at any depth (top level and inside test.describe), so wrapping a new test does not dodge the cap.
const TOTAL_CAP = 30

const spec = process.argv[2] ?? path.resolve(import.meta.dirname, '../tests/e2e/app.spec.ts')
const source = readFileSync(spec, 'utf8')
const count = (indent: string) =>
  source.match(new RegExp(`^${indent}test(\\.(only|skip|fixme|fail|slow))?\\(`, 'gm'))?.length ?? 0
const topLevel = count('')
const total = count('\\s*')

if (topLevel > TOP_LEVEL_CAP || total > TOTAL_CAP) {
  console.error(
    `${spec} has ${topLevel} top-level tests (cap ${TOP_LEVEL_CAP}) and ${total} in all (cap ${TOTAL_CAP}). ` +
      'Do not grow app.spec.ts: add a spec for its concern (styles.spec.ts, layout.spec.ts, csp.spec.ts, …) ' +
      'or start a new one in tests/e2e/.',
  )
  process.exit(1)
}
