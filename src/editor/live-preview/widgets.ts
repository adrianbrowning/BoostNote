import type { EditorState, TransactionSpec } from '@codemirror/state'
import { type EditorView, WidgetType } from '@codemirror/view'

import type { EditorTheme } from '../config.ts'
import { renderMath } from '../render/math.ts'
import { cachedMermaid, type MermaidResult, renderMermaid } from '../render/mermaid.ts'

/** `•` in place of a `-`/`*`/`+` bullet when the cursor is elsewhere. */
export class BulletWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-lp-bullet'
    span.textContent = '•'
    return span
  }
}

/** Toggles the GFM task marker (`[ ]` ↔ `[x]`) that starts at `pos`. */
export function toggleTaskAt(state: EditorState, pos: number): TransactionSpec | null {
  const marker = state.sliceDoc(pos, pos + 3)
  if (!/^\[[ xX]\]$/.test(marker)) return null
  return {
    changes: { from: pos + 1, to: pos + 2, insert: marker[1] === ' ' ? 'x' : ' ' },
    userEvent: 'input.toggle-task',
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-lp-checkbox'
    box.checked = this.checked
    box.setAttribute('aria-label', this.checked ? 'Mark task as not done' : 'Mark task as done')
    // Toggle on mousedown so the editor never moves the cursor into the marker (which would reveal it).
    box.addEventListener('mousedown', (event) => {
      event.preventDefault()
      const spec = toggleTaskAt(view.state, view.posAtDOM(box))
      if (spec) view.dispatch(spec)
    })
    box.addEventListener('click', (event) => event.preventDefault())
    return box
  }
  ignoreEvent(): boolean {
    return true
  }
}

export class HorizontalRuleWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const hr = document.createElement('hr')
    hr.className = 'cm-lp-hr'
    return hr
  }
}

export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly width: number | undefined,
    readonly height: number | undefined,
  ) {
    super()
  }
  eq(other: ImageWidget): boolean {
    return (
      other.src === this.src && other.alt === this.alt && other.width === this.width && other.height === this.height
    )
  }
  toDOM(view: EditorView): HTMLElement {
    const img = document.createElement('img')
    img.className = 'cm-lp-image'
    img.src = this.src
    img.alt = this.alt
    img.title = this.alt
    if (this.width) img.width = this.width
    if (this.height) img.height = this.height
    img.addEventListener('load', () => view.requestMeasure())
    img.addEventListener('error', () => img.classList.add('cm-lp-image-broken'))
    return img
  }
}

export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super()
  }
  eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.display === this.display
  }
  toDOM(): HTMLElement {
    const el = document.createElement(this.display ? 'div' : 'span')
    el.className = this.display ? 'cm-lp-math cm-lp-math-block' : 'cm-lp-math'
    el.innerHTML = renderMath(this.tex, this.display)
    return el
  }
  ignoreEvent(): boolean {
    return false
  }
}

export class TableWidget extends WidgetType {
  constructor(readonly html: string) {
    super()
  }
  eq(other: TableWidget): boolean {
    return other.html === this.html
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-lp-table'
    wrap.innerHTML = this.html
    return wrap
  }
  ignoreEvent(): boolean {
    return false
  }
}

const mermaidHeights = new Map<string, number>()

export class MermaidWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly theme: EditorTheme,
  ) {
    super()
  }
  eq(other: MermaidWidget): boolean {
    return other.source === this.source && other.theme === this.theme
  }
  get estimatedHeight(): number {
    return mermaidHeights.get(this.source) ?? 120
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-lp-mermaid'
    const cached = cachedMermaid(this.source, this.theme)
    if (cached) {
      this.fill(wrap, cached)
    } else {
      wrap.classList.add('cm-lp-mermaid-loading')
      wrap.textContent = 'Rendering diagram…'
      void renderMermaid(this.source, this.theme).then((result) => {
        this.fill(wrap, result)
        if (!wrap.isConnected) return
        view.requestMeasure({
          read: () => wrap.getBoundingClientRect().height,
          write: (height) => {
            if (height > 0) mermaidHeights.set(this.source, height)
          },
        })
      })
    }
    return wrap
  }
  private fill(wrap: HTMLElement, result: MermaidResult): void {
    wrap.classList.remove('cm-lp-mermaid-loading')
    if ('svg' in result) {
      // Sanitised by mermaid (securityLevel: 'strict' runs DOMPurify over the output).
      wrap.innerHTML = result.svg
      wrap.classList.remove('cm-lp-mermaid-error')
      return
    }
    wrap.classList.add('cm-lp-mermaid-error')
    wrap.replaceChildren()
    const title = document.createElement('strong')
    title.textContent = 'Mermaid error'
    const message = document.createElement('pre')
    message.textContent = result.error
    wrap.append(title, message)
  }
  ignoreEvent(): boolean {
    return false
  }
}

export class CodeLanguageWidget extends WidgetType {
  constructor(readonly language: string) {
    super()
  }
  eq(other: CodeLanguageWidget): boolean {
    return other.language === this.language
  }
  toDOM(): HTMLElement {
    const label = document.createElement('span')
    label.className = 'cm-lp-code-lang'
    label.textContent = this.language
    label.setAttribute('aria-hidden', 'true')
    return label
  }
}
