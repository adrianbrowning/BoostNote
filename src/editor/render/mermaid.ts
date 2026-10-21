import type { Mermaid } from 'mermaid'

import type { EditorTheme } from '../config.ts'

export type MermaidResult = { svg: string } | { error: string }

/**
 * Loads mermaid on first use. The self-contained ESM build is used because `mermaid`'s main entry
 * pulls in CommonJS dependencies the asset server cannot serve.
 */
let mermaidModule: Promise<Mermaid> | undefined
function loadMermaid(): Promise<Mermaid> {
  mermaidModule ??= import('mermaid/dist/mermaid.esm.min.mjs').then((mod) => mod.default)
  return mermaidModule
}

const CACHE_LIMIT = 100
const pending = new Map<string, Promise<MermaidResult>>()
const rendered = new Map<string, MermaidResult>()
let queue: Promise<unknown> = Promise.resolve()
let nextId = 0

const cacheKey = (source: string, theme: EditorTheme) => `${theme}\n${source}`

/** A finished render for this source + theme, if one is cached. */
export function cachedMermaid(source: string, theme: EditorTheme): MermaidResult | undefined {
  return rendered.get(cacheKey(source, theme))
}

/**
 * Renders a diagram to SVG. Results are cached by source + theme. Renders run one at a time because
 * `mermaid.initialize` is global and `render` measures text in a shared temporary element.
 */
export function renderMermaid(source: string, theme: EditorTheme): Promise<MermaidResult> {
  const key = cacheKey(source, theme)
  const done = rendered.get(key)
  if (done) return Promise.resolve(done)
  const inFlight = pending.get(key)
  if (inFlight) return inFlight

  const result = queue.then(async (): Promise<MermaidResult> => {
    const id = `boost-mermaid-${++nextId}`
    try {
      const mermaid = await loadMermaid()
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: theme === 'dark' ? 'dark' : 'default',
        suppressErrorRendering: true,
      })
      const { svg } = await mermaid.render(id, source)
      return { svg }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    } finally {
      // mermaid leaves its measuring container behind when rendering fails.
      for (const stray of document.querySelectorAll(`#${id}, #d${id}`)) stray.remove()
    }
  })
  queue = result
  pending.set(key, result)
  void result.then((value) => {
    pending.delete(key)
    rendered.set(key, value)
    if (rendered.size > CACHE_LIMIT) rendered.delete(rendered.keys().next().value as string)
  })
  return result
}
