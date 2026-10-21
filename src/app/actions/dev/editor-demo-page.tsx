import { css } from 'remix/component'

import { katexStylesHref } from '../../assets.ts'
import { Document } from '../../ui/document.tsx'
import { EditorDemo } from './public/editor-demo.tsx'

const SAMPLE = `# Live preview editor

Type markdown here. **Bold**, *italic*, ~~strikethrough~~, \`inline code\` and [links](https://boostnote.io)
hide their markers until the cursor touches them. Cmd/Ctrl-click a link to open it.

> Blockquotes lose their \`>\` when the cursor is elsewhere.

- [ ] An open task
- [x] A finished task
- A plain bullet
  1. Nested numbered item

Inline math $e^{i\\pi} + 1 = 0$ and a block:

$$
\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}
$$

\`\`\`mermaid
flowchart LR
  A[Markdown] --> B{Live preview}
  B --> C[Widgets]
\`\`\`

| Feature | Status |
| :-- | --: |
| Tables | **rendered** |
| Math | $x^2$ |

---

\`\`\`ts
const greet = (name: string) => \`Hello \${name}\`
\`\`\`

Type \`/\` at the start of a line for blocks.
`

/** Development harness for the live-preview editor (`GET /dev/editor`). Phase 4 replaces it with the real workspace. */
export function EditorDemoPage() {
  return () => (
    <Document title="Editor demo" head={<link rel="stylesheet" href={katexStylesHref} />}>
      <div mix={pageStyle}>
        <EditorDemo doc={SAMPLE} />
      </div>
    </Document>
  )
}

const pageStyle = css({ height: '100vh' })
