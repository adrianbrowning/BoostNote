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
      const { svg } = await withStampedStyles(id, () => mermaid.render(id, source))
      // Strip the nonce `withStampedStyles` put on the `<style>`: the result is cached and exported
      // to files, where a page nonce means nothing; `mermaidNodes` stamps the current page's nonce on
      // insertion.
      return { svg: parseSvg(svg, null).innerHTML }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    } finally {
      // mermaid leaves its measuring container behind when rendering fails.
      for (const stray of document.querySelectorAll(measuringContainer(id))) stray.remove()
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

/** Mermaid's measuring container (`#d<id>`) and the SVG inside it (`#<id>`). */
const measuringContainer = (id: string) => `#d${id}, #${id}`

/**
 * `mermaid.render` lays the diagram out in a temporary SVG in the page and inserts its `<style>`
 * there; mermaid takes no nonce, so the page policy (`style-src-elem`) would block it and the
 * layout would be measured unstyled. While `render` runs, style elements made with
 * `document.createElement` get the page nonce as a property (which the policy checks on
 * insertion, and which adds no attribute), and only those Mermaid inserts into its measuring
 * container (`#d<id>` around the SVG `#<id>`) also get it as an attribute. Renders run one at a
 * time (the queue above).
 *
 * Verified against Mermaid 12.2.0, and relies on its internals: it creates the `<style>` with
 * `document.createElement`, inserts it into the measuring SVG synchronously right after, then
 * serialises that SVG and has DOMPurify parse the string. Re-check this on a Mermaid upgrade
 * (`tests/e2e/csp.spec.ts` guards it), and drop the patch once Mermaid accepts a nonce.
 */
async function withStampedStyles<T>(id: string, render: () => Promise<T>): Promise<T> {
  const nonce = pageCspNonce()
  const container = measuringContainer(id)
  const createElement = document.createElement
  document.createElement = function (this: Document, ...args: Parameters<Document['createElement']>) {
    const element = createElement.apply(this, args)
    if (element instanceof HTMLStyleElement) {
      element.nonce = nonce
      // The property lets mermaid insert the element, but mermaid then serialises the SVG and
      // DOMPurify parses that string under the page policy too, which needs the attribute: set it
      // once mermaid has inserted the element (synchronously, right after creating it). Without
      // this the page reports style-src-elem violations. Only Mermaid's own styles get it: one
      // made elsewhere meanwhile (CodeMirror's, say) has no nonce attribute. The nonce is then
      // readable as an attribute while the render runs; REMIX-NOTES says why that is accepted.
      queueMicrotask(() => {
        if (element.closest(container)) element.setAttribute('nonce', nonce)
      })
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
 * Nodes of a rendered diagram, ready to insert into the page: its `<style>` elements carry the
 * page nonce, without which the page policy (`style-src-elem`) blocks them.
 */
export function mermaidNodes(svg: string): DocumentFragment {
  return parseSvg(svg, pageCspNonce()).content
}

/** `svg` parsed into a template, with `nonce` set on its `<style>` elements, or removed when null. */
function parseSvg(svg: string, nonce: string | null): HTMLTemplateElement {
  const template = document.createElement('template')
  template.innerHTML = svg
  for (const style of template.content.querySelectorAll('style')) {
    if (nonce === null) style.removeAttribute('nonce')
    else style.setAttribute('nonce', nonce)
  }
  return template
}
