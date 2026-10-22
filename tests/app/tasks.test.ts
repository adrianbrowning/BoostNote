import { describe, expect, it } from 'vitest'

import { taskProgress } from '../../src/app/actions/public/workspace/tasks.ts'

describe('taskProgress', () => {
  it('counts open and done tasks across bullet styles, nesting, quotes and numbered lists', () => {
    const body = [
      '## TODO',
      '- [ ] Lia - LABSIN-69',
      '- [x] Lia - LABSIN-64',
      '* [X] upper-case x',
      '+ [ ] plus bullet',
      '  - [x] nested',
      '> - [ ] in a quote',
      '1. [x] numbered',
      '2) [ ] numbered paren',
    ].join('\n')
    expect(taskProgress(body)).toEqual({ total: 8, completed: 4, percent: 50 })
  })

  it('ignores things that only look like tasks', () => {
    const body = [
      '- [] no space inside',
      '- []',
      '-[ ] no space after bullet',
      'text - [ ] mid-line',
      '- [ ]not separated',
      '```md',
      '- [x] inside a fence',
      '```',
      '~~~',
      '- [ ] tilde fence',
      '~~~',
      '- [ ] counted',
    ].join('\n')
    expect(taskProgress(body)).toEqual({ total: 1, completed: 0, percent: 0 })
  })

  it('rounds down like the legacy bar and reports 0 for no tasks', () => {
    expect(taskProgress('- [x] a\n- [ ] b\n- [ ] c\n').percent).toBe(33)
    expect(taskProgress('- [x] only\n').percent).toBe(100)
    expect(taskProgress('Plain text.\n')).toEqual({ total: 0, completed: 0, percent: 0 })
  })
})
