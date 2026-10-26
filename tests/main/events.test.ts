import { describe, expect, it } from 'vitest'

import { createEventHub, formatEvent } from '../../src/main/events.ts'

const decoder = new TextDecoder()

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await reader.read()
  if (done) throw new Error('stream ended')
  return decoder.decode(value)
}

describe('event hub', () => {
  it('responds with an event stream', () => {
    const response = createEventHub().subscribe()
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('formats events as SSE frames named after their type', () => {
    expect(formatEvent({ type: 'menu', command: 'new-note' })).toBe(
      'event: menu\ndata: {"type":"menu","command":"new-note"}\n\n',
    )
  })

  it('delivers broadcasts to every subscriber', async () => {
    const hub = createEventHub()
    const readers = [hub.subscribe(), hub.subscribe()].map((response) => {
      if (!response.body) throw new Error('missing body')
      return response.body.getReader()
    })
    expect(hub.size).toBe(2)

    for (const reader of readers) expect(await readChunk(reader)).toBe('retry: 1000\n\n')
    hub.broadcast({ type: 'menu', command: 'new-note' })
    for (const reader of readers) {
      expect(await readChunk(reader)).toBe(formatEvent({ type: 'menu', command: 'new-note' }))
    }
  })

  it('drops streams the client cancels', async () => {
    const hub = createEventHub()
    const kept = hub.subscribe().body?.getReader()
    const cancelled = hub.subscribe().body?.getReader()
    if (!kept || !cancelled) throw new Error('missing body')
    expect(hub.size).toBe(2)

    await cancelled.cancel()
    expect(hub.size).toBe(1)

    await readChunk(kept)
    hub.broadcast({ type: 'menu', command: 'new-note' })
    expect(await readChunk(kept)).toContain('"command":"new-note"')
  })

  it('closes and drops a stream when its request aborts', async () => {
    const hub = createEventHub()
    const controller = new AbortController()
    const reader = hub.subscribe(controller.signal).body?.getReader()
    if (!reader) throw new Error('missing body')
    await readChunk(reader)

    controller.abort()
    expect(hub.size).toBe(0)
    expect(await reader.read()).toEqual({ value: undefined, done: true })
  })

  it('never registers a stream whose request was already aborted', () => {
    const hub = createEventHub()
    hub.subscribe(AbortSignal.abort())
    expect(hub.size).toBe(0)
  })

  it('close() ends every stream', async () => {
    const hub = createEventHub()
    const reader = hub.subscribe().body?.getReader()
    if (!reader) throw new Error('missing body')
    await readChunk(reader)

    hub.close()
    expect(hub.size).toBe(0)
    expect((await reader.read()).done).toBe(true)
  })
})
