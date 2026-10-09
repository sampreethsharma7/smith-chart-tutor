import { describe, expect, it, vi } from 'vitest'
import type { ProviderConfig, StreamEvent } from '@shared/llm'

// Each call to the fake Gemini takes the next script: 'silent' never answers, 'partial' sends some text then goes quiet.
const scripts: Array<'silent' | 'partial' | 'ok'> = []
let calls = 0
vi.mock('./gemini', () => ({
  geminiModels: async () => [],
  geminiChat: (_c: unknown, _k: unknown, _r: unknown, emit: (ev: StreamEvent) => void, signal: AbortSignal) => {
    calls++
    const script = scripts.shift() ?? 'ok'
    if (script === 'ok') {
      emit({ type: 'text', delta: 'hello' })
      return Promise.resolve()
    }
    if (script === 'partial') emit({ type: 'text', delta: 'half a rep' })
    return new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('This operation was aborted'))))
  }
}))

const { runChat, abortChat } = await import('./index')
const cfg: ProviderConfig = { id: 'g', label: 'Gemini test', kind: 'gemini', model: 'gemini-test' }
const req = { providerId: 'g', system: { stable: '' }, messages: [] }

async function run(...s: typeof scripts) {
  scripts.splice(0, scripts.length, ...s)
  calls = 0
  const events: StreamEvent[] = []
  await runChat(cfg, 'k', req as never, `r${Math.random()}`, (ev) => events.push(ev), { stallMs: 30 })
  return events
}

describe('stall limit', () => {
  it('a model that never answers is asked once more, then reported as stopped', async () => {
    const events = await run('silent', 'silent')
    expect(calls).toBe(2)
    const err = events.find((e) => e.type === 'error')
    expect(err && 'message' in err && err.message).toMatch(/Gemini test stopped responding/)
  })

  it('a silent first attempt followed by an answer just works', async () => {
    const events = await run('silent', 'ok')
    expect(calls).toBe(2)
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.some((e) => e.type === 'text')).toBe(true)
  })

  it('a reply that stops halfway is not sent twice', async () => {
    const events = await run('partial')
    expect(calls).toBe(1)
    const err = events.find((e) => e.type === 'error')
    expect(err && 'message' in err && err.message).toMatch(/stopped responding/)
  })

  it('Stop still reads as cancelled, not as a stall', async () => {
    scripts.splice(0, scripts.length, 'silent')
    const events: StreamEvent[] = []
    const p = runChat(cfg, 'k', req as never, 'stop-me', (ev) => events.push(ev), { stallMs: 10_000 })
    abortChat('stop-me')
    await p
    const err = events.find((e) => e.type === 'error')
    expect(err && 'message' in err && err.message).toBe('Cancelled')
  })
})
