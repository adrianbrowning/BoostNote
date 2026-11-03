import { describe, expect, it } from 'vitest'

import { isReservedShortcut } from '../../src/app/actions/public/workspace/shortcuts.ts'

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
})
