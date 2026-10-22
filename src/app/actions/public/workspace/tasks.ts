export interface TaskProgress {
  total: number
  completed: number
  /** Whole percent, rounded down (as the legacy Boostnote bar did). */
  percent: number
}

const FENCE = /^\s*(?:>\s*)*(`{3,}|~{3,})/
// A GFM task item: bullet (`-`, `*`, `+`) or numbered (`1.`, `1)`) list item starting with `[ ]`/`[x]`.
const TASK = /^\s*(?:>\s*)*(?:[-*+]|\d{1,9}[.)])\s+\[([ xX])\](?:\s|$)/

/** Counts the task list items in a note body; code blocks are skipped. */
export function taskProgress(body: string): TaskProgress {
  let total = 0
  let completed = 0
  let fence: string | null = null
  for (const line of body.split('\n')) {
    const marker = FENCE.exec(line)?.[1]
    if (marker !== undefined) {
      if (fence === null) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
      continue
    }
    if (fence !== null) continue
    const match = TASK.exec(line)
    if (!match) continue
    total++
    if (match[1] !== ' ') completed++
  }
  return { total, completed, percent: total === 0 ? 0 : Math.floor((completed / total) * 100) }
}
