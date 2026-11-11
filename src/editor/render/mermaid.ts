import type { Mermaid } from 'mermaid'

import type { EditorTheme } from '../config.ts'
import { pageCspNonce } from './csp-nonce.ts'

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
      const { svg } = await withStampedStyles(() => mermaid.render(id, source))
      return { svg: withoutNonces(svg) }
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

/**
 * `mermaid.render` lays the diagram out in a temporary SVG in the page and inserts its `<style>`
 * there; mermaid takes no nonce, so the page policy (`style-src-elem`) would block it and the
 * layout would be measured unstyled. While `render` runs, style elements made with
 * `document.createElement` get the page nonce. Renders run one at a time (the queue above).
 */
async function withStampedStyles<T>(render: () => Promise<T>): Promise<T> {
  const nonce = pageCspNonce()
  const createElement = document.createElement
  document.createElement = function (this: Document, ...args: Parameters<Document['createElement']>) {
    const element = createElement.apply(this, args)
    if (element instanceof HTMLStyleElement) {
      element.setAttribute('nonce', nonce)
      // Inserting the element hides the attribute (the property keeps it), but mermaid then
      // serialises the SVG and DOMPurify parses that string under the page policy too: set it
      // again once mermaid has inserted the element (synchronously, right after creating it).
      queueMicrotask(() => element.setAttribute('nonce', nonce))
    }
    return element
  } as Document['createElement']
  try {
    return await render()
  } finally {
    document.createElement = createElement
  }
}

/**
 * The rendered SVG without the nonce `withStampedStyles` gave its `<style>`: the result is cached
 * and exported to files, where a stale page nonce means nothing, and `mermaidNodes` stamps the
 * current one when it is inserted.
 */
function withoutNonces(svg: string): string {
  const template = document.createElement('template')
  template.innerHTML = svg
  for (const style of template.content.querySelectorAll('style')) style.removeAttribute('nonce')
  return template.innerHTML
}

/**
 * Nodes of a rendered diagram, ready to insert into the page: its `<style>` elements carry the
 * page nonce, without which the page policy (`style-src-elem`) blocks them.
 */
export function mermaidNodes(svg: string): DocumentFragment {
  const template = document.createElement('template')
  template.innerHTML = svg
  const nonce = pageCspNonce()
  for (const style of template.content.querySelectorAll('style')) style.setAttribute('nonce', nonce)
  return template.content
}
