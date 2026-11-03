import { describe, expect, it } from 'vitest'

import { isReservedShortcut } from '../../src/app/actions/public/workspace/shortcuts.ts'
import { COMMANDS, commandAccelerators } from '../../src/shared/commands.ts'

const key = (
  code: string,
  modifiers: Partial<Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>> = {},
) => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers }) as KeyboardEvent

describe('isReservedShortcut', () => {
  it('reserves CmdOrCtrl accelerators as ⌘ on macOS and Ctrl elsewhere', () => {
    expect(isReservedShortcut(key('KeyN', { metaKey: true }), true)).toBe(true)
    expect(isReservedShortcut(key('KeyN', { ctrlKey: true }), true)).toBe(false)
    expect(isReservedShortcut(key('KeyN', { ctrlKey: true }), false)).toBe(true)
    expect(isReservedShortcut(key('KeyN', { metaKey: true }), false)).toBe(false)
  })

  it('reserves the numbered tab accelerators', () => {
    expect(isReservedShortcut(key('Digit1', { metaKey: true }), true)).toBe(true)
    expect(isReservedShortcut(key('Digit9', { ctrlKey: true }), false)).toBe(true)
    expect(isReservedShortcut(key('Digit0', { metaKey: true }), true)).toBe(false)
  })

  it('matches modifiers exactly', () => {
    expect(isReservedShortcut(key('KeyN', { metaKey: true, shiftKey: true }), true)).toBe(true)
    expect(isReservedShortcut(key('KeyR', { metaKey: true, altKey: true }), true)).toBe(true)
    expect(isReservedShortcut(key('KeyR', { metaKey: true }), true)).toBe(false)
    expect(isReservedShortcut(key('KeyN'), true)).toBe(false)
  })

  it('maps punctuation and Tab keys', () => {
    expect(isReservedShortcut(key('BracketLeft', { metaKey: true }), true)).toBe(true)
    expect(isReservedShortcut(key('BracketRight', { ctrlKey: true }), false)).toBe(true)
    expect(isReservedShortcut(key('Comma', { metaKey: true }), true)).toBe(true)
    expect(isReservedShortcut(key('Tab', { ctrlKey: true }), true)).toBe(true)
    expect(isReservedShortcut(key('Tab', { ctrlKey: true, shiftKey: true }), false)).toBe(true)
  })

  it('leaves unbound keys and roles alone', () => {
    expect(isReservedShortcut(key('KeyB', { metaKey: true }), true)).toBe(false)
    expect(isReservedShortcut(key('KeyW', { metaKey: true, shiftKey: true }), true)).toBe(false)
  })

  // Electron accelerator key → KeyboardEvent.code, written out independently of shortcuts.ts.
  const CODE: Record<string, string> = { '[': 'BracketLeft', ']': 'BracketRight', ',': 'Comma', Tab: 'Tab' }
  const accelerators = COMMANDS.flatMap(commandAccelerators)
  it.each(accelerators.flatMap((accelerator) => [true, false].map((isMac) => [accelerator, isMac] as const)))(
    'reserves %s (macOS: %s)',
    (accelerator, isMac) => {
      const parts = accelerator.split('+')
      const last = parts.at(-1) ?? ''
      const code = CODE[last] ?? (/^\d$/.test(last) ? `Digit${last}` : `Key${last}`)
      const mod = parts.includes('CmdOrCtrl')
      const event = key(code, {
        metaKey: mod && isMac,
        ctrlKey: parts.includes('Ctrl') || (mod && !isMac),
        altKey: parts.includes('Alt'),
        shiftKey: parts.includes('Shift'),
      })
      expect(isReservedShortcut(event, isMac)).toBe(true)
    },
  )

  it('covers every table accelerator, tab accelerators included', () => {
    expect(accelerators).toHaveLength(25)
  })
})
