import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatRequest, Part } from '@shared/llm'

// ── A scripted model and an in-memory app (as in tasks.flow.test.ts), for a very long lesson ──
type Reply = Part[] | ((req: ChatRequest) => Part[])
const script: Reply[] = []
const requests: ChatRequest[] = []
/** Side calls: running lesson notes and the end-of-lesson summary */
const notes: ChatRequest[] = []
const summaries: ChatRequest[] = []
const saved: { conversation: unknown; profiles: number } = { conversation: null, profiles: 0 }
const app = vi.hoisted(() => ({ profile: null as any }))

vi.mock('@/state/app', async () => {
  const { createProfile, migrateProfile } = await import('@shared/profile')
  app.profile = migrateProfile(createProfile('Sam'))
  const state = {
    get profile() { return app.profile },
    settings: { benchmarks: {} },
    updateProfile: async (fn: (p: any) => any) => { app.profile = fn(app.profile); saved.profiles++ }
  }
  return {
    activeProvider: () => ({ id: 'fake', label: 'Fake model', supportsTools: true }),
    useApp: { getState: () => state, subscribe: () => () => {} },
    api: () => ({
      llm: {
        chat: (req: ChatRequest) => {
          const side = req.system.stable.startsWith('You keep running notes') ? notes : req.system.stable.startsWith('You write short notes') ? summaries : null
          side?.push(req)
          if (!side) requests.push(req)
          const next = side === notes ? text(`Notes v${notes.length}: covered lines and stubs; confused z and y early on.`)
            : side === summaries ? text('Summary of a long lesson.')
            : script.shift() ?? [{ type: 'text', text: 'OK.' }]
          const parts = typeof next === 'function' ? next(req) : next
          const message: ChatMessage = { role: 'assistant', parts }
          return { requestId: `r${requests.length}`, done: Promise.resolve({ type: 'done', result: { message, stopReason: 'end', usage: {}, timing: { ttftMs: 1, totalMs: 1 } } }) }
        },
        abort: () => {}
      },
      conversation: { save: async (_id: string, c: unknown) => { saved.conversation = c }, get: async () => null }
    })
  }
})
vi.stubGlobal('window', { addEventListener: () => {} })

const { useStudio, DEFAULT_SNAPSHOT } = await import('@/state/studio')
const { useTutor, flushConversation } = await import('./tutor')
const { createProfile, migrateProfile } = await import('@shared/profile')
const { gradeOpenQuestion } = await import('./answers')

const text = (t: string): Part[] => [{ type: 'text', text: t }]
const call = (name: string, args: Record<string, unknown>, t = ''): Part[] => [...(t ? text(t) : []), { type: 'tool_call', id: `c_${name}_${Math.random()}`, name, args }]
const size = (x: unknown) => JSON.stringify(x).length

/** Every request a provider gets must be well formed, however long the lesson. */
function wellFormed(req: ChatRequest) {
  const m = req.messages
  expect(m[0].role).toBe('user')
  expect(m[0].parts.some((p) => p.type === 'tool_result')).toBe(false)
  for (let i = 1; i < m.length; i++) expect(m[i].role).not.toBe(m[i - 1].role)
  // Each tool result answers a call in the message just before it, and each call is answered.
  for (let i = 0; i < m.length; i++) {
    const results = m[i].parts.filter((p) => p.type === 'tool_result') as Extract<Part, { type: 'tool_result' }>[]
    if (results.length) {
      const calls = new Set((m[i - 1]?.parts ?? []).filter((p) => p.type === 'tool_call').map((p) => (p as Extract<Part, { type: 'tool_call' }>).id))
      for (const r of results) expect(calls.has(r.callId)).toBe(true)
    }
    const calls = m[i].parts.filter((p) => p.type === 'tool_call')
    if (calls.length && i < m.length - 1) expect(m[i + 1].parts.filter((p) => p.type === 'tool_result')).toHaveLength(calls.length)
  }
}

describe('a learner who keeps chatting for hours', () => {
  it('1500 turns of chat, tools and cards: every request stays well formed and bounded, and state stays bounded', async () => {
    useTutor.getState().reset()
    useTutor.setState({ profileId: app.profile.id })
    useStudio.getState().loadSnapshot({ ...DEFAULT_SNAPSHOT, load: { kind: 'fixed', R: 30, X: 20 } })
    const long = (i: number) => `Message ${i}: ${'I wonder how the point moves when I add a shunt capacitor and then a short line, and why the VSWR stays the same. '.repeat(3)}`
    const timings: number[] = []
    const T = 1500
    for (let i = 0; i < T; i++) {
      const t0 = performance.now()
      const kind = i % 6
      if (kind === 0) script.push(call('get_chart_state', {}), text(`Reply ${i}. ${'Here is a careful explanation. '.repeat(8)}`))
      else if (kind === 1) script.push(call('what_if', { start: 'load', elements: [{ kind: 'tline', value: 45, zc: 50 }] }), call('rf_calculate', { operation: 'convert', value: '30+j20' }), text(`Reply ${i}.`))
      else if (kind === 2) script.push(call('ask_move', { element: { kind: 'shuntC', value: 2e-12 }, from: 'load' }, 'A quick question:'))
      else script.push(text(`Reply ${i}. ${'Think about the constant-r circle. '.repeat(6)}`))
      await useTutor.getState().send(long(i))
      // Answer the card on the next turn, sometimes instead of typing.
      const p = useStudio.getState().prediction
      if (p?.key?.type === 'move') {
        script.push(text(`Graded reply ${i}.`))
        const k = p.key
        await gradeOpenQuestion(k.choices[(i / 6) % 2 ? k.correct : (k.correct + 1) % k.choices.length], 'sure', k.reasons?.choices[k.reasons.correct]).finish?.()
      }
      timings.push(performance.now() - t0)
    }
    // A huge paste (a whole data file): the chat shows it, the model gets a shortened copy.
    const paste = 'Here is my S11 data:\n' + '2.400e9 0.31 -0.12\n'.repeat(12000)
    await useTutor.getState().send(paste)
    expect(useTutor.getState().items.some((i) => i.kind === 'user' && i.text === paste)).toBe(true)
    const pasted = requests.at(-1)!.messages.at(-1)!.parts.find((p) => p.type === 'text') as { text: string }
    expect(pasted.text.length).toBeLessThan(13000)
    expect(pasted.text).toMatch(/characters left out here/)
    flushConversation()

    // Every request: well formed and bounded in messages and characters.
    const last = requests.slice(-200)
    for (const r of last) wellFormed(r)
    const chars = requests.map((r) => size(r.messages))
    const sys = requests.map((r) => (r.system.dynamic ?? "").length + r.system.stable.length)
    const s = useTutor.getState()
    const report = {
      requests: requests.length,
      maxMessages: Math.max(...requests.map((r) => r.messages.length)),
      maxHistoryChars: Math.max(...chars),
      lastHistoryChars: chars.at(-1),
      maxSystemChars: Math.max(...sys),
      firstSystemChars: sys[0],
      items: s.items.length,
      history: s.history.length,
      transcript: s.session?.transcript.length,
      profileChars: size(app.profile),
      sessionChars: size(s.session),
      savedConversationChars: size(saved.conversation),
      msFirst100: Math.round(timings.slice(0, 100).reduce((a, b) => a + b, 0)),
      msLast100: Math.round(timings.slice(-100).reduce((a, b) => a + b, 0))
    }
    if (process.env.LONG_REPORT) (await import('node:fs')).writeFileSync(process.env.LONG_REPORT, JSON.stringify(report, null, 2))

    expect(report.maxMessages).toBeLessThanOrEqual(60)
    expect(report.maxHistoryChars).toBeLessThan(80_000)
    expect(report.maxSystemChars).toBeLessThan(report.firstSystemChars + 2000) // the notes add a little, nothing grows
    expect(report.items).toBeLessThanOrEqual(1000)
    expect(report.history).toBeLessThanOrEqual(180)
    // Stored lesson: its latest 2000 messages (each at most ~4000 characters), with the true count.
    expect(report.transcript).toBeLessThanOrEqual(2000)
    // Every message counted: per 6 turns, 6 learner messages, 1 card answer and 6 replies (one turn ends on its card, its answer gets one); plus the paste and its reply.
    expect(useTutor.getState().session!.messageCount).toBe((T / 6) * 14 + 2)
    expect(report.sessionChars).toBeLessThan(1_000_000)
    expect(report.savedConversationChars).toBeLessThan(1_500_000)
    // The saved conversation starts on a learner turn, so a reloaded lesson sends a valid request.
    const conv = saved.conversation as { history: ChatMessage[] }
    expect(conv.history[0].role).toBe('user')
    expect(conv.history[0].parts.some((p) => p.type === 'tool_result')).toBe(false)

    // Running notes: the older lesson is folded into them, each time on top of the notes so far,
    // and the tutor gets them in every request.
    expect(notes.length).toBeGreaterThan(10)
    const digest = useTutor.getState().session!.digest!
    expect(digest.upTo).toBeGreaterThan(report.transcript! - 24 - 40 - 2)
    expect((notes.at(-1)!.messages[0].parts[0] as { text: string }).text).toMatch(/^Notes so far:\nNotes v/)
    expect(requests.at(-1)!.system.dynamic).toContain(`Earlier in this lesson (your running notes`)
    expect(requests.at(-1)!.system.dynamic).toContain(digest.text)

    // The lesson summary covers the whole lesson: the notes for the start, the transcript for the rest.
    await useTutor.getState().endSession()
    expect((summaries.at(-1)!.messages[0].parts[0] as { text: string }).text).toContain(`[Notes on the earlier part of the lesson] ${digest.text}`)
  }, 600_000)

  it('a long lesson with no notes yet (an older saved one) is caught up oldest first, so its start is not lost', async () => {
    app.profile = migrateProfile(createProfile('Sam'))
    useTutor.getState().reset()
    useTutor.setState({ profileId: app.profile.id })
    notes.length = 0
    const transcript = Array.from({ length: 400 }, (_, i) => ({
      role: i % 2 ? 'tutor' as const : 'user' as const,
      text: i === 0 ? 'My antenna is a PIFA at 22 − j31 Ω, called Bluebird.' : `Message ${i}: ${'more talk about circles and lines. '.repeat(10)}`,
      at: '2026-09-01T00:00:00Z'
    }))
    useTutor.setState({ session: { id: 's_old', startedAt: '2026-09-01T00:00:00Z', transcript, exercises: [] } })
    script.push(text('Hi again.'))
    await useTutor.getState().send('What was my antenna called?')
    // At most 8 chunks a turn (no burst of calls); the rest is caught up on the next turn.
    await vi.waitFor(() => expect(notes).toHaveLength(8))
    await vi.waitFor(() => expect(useTutor.getState().session!.digest?.upTo).toBeGreaterThan(200))
    script.push(text('It was Bluebird.'))
    await useTutor.getState().send('Thanks')
    await vi.waitFor(() => expect(useTutor.getState().session!.digest?.upTo).toBeGreaterThan(402 - 24 - 1))
    const first = (notes[0].messages[0].parts[0] as { text: string }).text
    expect(first).toMatch(/^Next part of the lesson:\nLearner: My antenna is a PIFA at 22 − j31 Ω, called Bluebird\./)
    expect(notes.length).toBeGreaterThan(1)
    expect((notes[1].messages[0].parts[0] as { text: string }).text).toMatch(/^Notes so far:\nNotes v1/)
  })

  it('older lessons keep their summary and last messages in storage; recent ones keep everything', async () => {
    const msg = (i: number) => ({ role: i % 2 ? 'tutor' as const : 'user' as const, text: `m${i}`, at: '2026-09-01T00:00:00Z' })
    const old = Array.from({ length: 30 }, (_, k) => ({ id: `s${k}`, startedAt: '2026-09-01T00:00:00Z', summary: `Lesson ${k}`, transcript: Array.from({ length: 100 }, (_, i) => msg(i)), exercises: [] }))
    app.profile = { ...migrateProfile(createProfile('Sam')), sessions: old }
    useTutor.getState().reset()
    useTutor.setState({ profileId: app.profile.id })
    script.push(text('Hi.'))
    await useTutor.getState().send('hello')
    const ss = app.profile.sessions
    expect(ss).toHaveLength(31)
    expect(ss[0].transcript).toHaveLength(20)
    expect(ss[0].messageCount).toBe(100)
    expect(ss[0].transcript.at(-1).text).toBe('m99')
    expect(ss.at(-2).transcript).toHaveLength(100)
    expect(ss.filter((x: any) => x.transcript.length === 20)).toHaveLength(31 - 20)
  })
})
