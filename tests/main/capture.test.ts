import { describe, expect, it } from 'vitest'

import { createCaptureHandler } from '../../src/main/capture.ts'
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
