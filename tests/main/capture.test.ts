import { describe, expect, it } from 'vitest'

import { createCaptureHandler, registerStoredHotkeys } from '../../src/main/capture.ts'
import type { MenuEvent } from '../../src/shared/commands.ts'

describe('Quick capture handler', () => {
  it('shows the window, then sends New Scratch Note, on every press', () => {
    const calls: Array<'show' | MenuEvent> = []
    const capture = createCaptureHandler({
      show: () => calls.push('show'),
      send: (event) => calls.push(event),
    })

    capture()
    capture()

    expect(calls).toEqual([
      'show',
      { type: 'menu', command: 'new-scratch-note' },
      'show',
      { type: 'menu', command: 'new-scratch-note' },
    ])
  })
})

describe('registerStoredHotkeys', () => {
  function fake(refused: string[] = []) {
    const calls: Array<[string, string]> = []
    const preferences = {
      setHotkey: (accelerator: string) => {
        calls.push(['global', accelerator])
        return !refused.includes(accelerator)
      },
      setCaptureHotkey: (accelerator: string) => {
        calls.push(['capture', accelerator])
        return !refused.includes(accelerator)
      },
    }
    const warnings: string[] = []
    return { calls, preferences, warnings, warn: (message: string) => warnings.push(message) }
  }

  it('registers only the show/hide hotkey when the stored capture hotkey presses the same keys', () => {
    const { calls, preferences, warnings, warn } = fake()
    registerStoredHotkeys(preferences, { globalHotkey: 'Control+Alt+K', captureHotkey: 'Alt+Ctrl+k' }, warn)
    expect(calls).toEqual([['global', 'Control+Alt+K']])
    expect(warnings).toEqual(['Could not register the Quick capture hotkey Alt+Ctrl+k'])
  })

  it('warns about a refused capture hotkey and keeps the show/hide one registered', () => {
    const { calls, preferences, warnings, warn } = fake(['Control+Alt+J'])
    registerStoredHotkeys(preferences, { globalHotkey: 'Control+Alt+K', captureHotkey: 'Control+Alt+J' }, warn)
    expect(calls).toEqual([
      ['global', 'Control+Alt+K'],
      ['capture', 'Control+Alt+J'],
    ])
    expect(warnings).toEqual(['Could not register the Quick capture hotkey Control+Alt+J'])
  })

  it('registers no capture hotkey when it is off, with no warning', () => {
    const { calls, preferences, warnings, warn } = fake()
    registerStoredHotkeys(preferences, { globalHotkey: 'Control+Alt+K', captureHotkey: '' }, warn)
    expect(calls).toEqual([['global', 'Control+Alt+K']])
    expect(warnings).toEqual([])
  })

  it('warns about a refused show/hide hotkey and still registers the capture hotkey', () => {
    const { calls, preferences, warnings, warn } = fake(['Control+Alt+K'])
    registerStoredHotkeys(preferences, { globalHotkey: 'Control+Alt+K', captureHotkey: 'Control+Alt+J' }, warn)
    expect(calls).toEqual([
      ['global', 'Control+Alt+K'],
      ['capture', 'Control+Alt+J'],
    ])
    expect(warnings).toEqual(['Could not register the hotkey Control+Alt+K'])
  })
})
