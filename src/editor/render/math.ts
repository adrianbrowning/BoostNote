import katex from 'katex'

/** KaTeX HTML for `tex`. Invalid TeX renders KaTeX's inline error (red source) instead of throwing. */
export function renderMath(tex: string, displayMode: boolean): string {
  return katex.renderToString(tex, {
    displayMode,
    throwOnError: false,
    output: 'htmlAndMathml',
    trust: false,
    strict: 'ignore',
  })
}
