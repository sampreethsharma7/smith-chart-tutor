import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatRequest, Part } from '@shared/llm'
import { c } from '@shared/rf/complex'
import { gammaFromZ } from '@shared/rf/metrics'
import { applyElement, inputImpedance } from '@shared/rf/network'
import { findReach, parseTarget } from '@shared/rf/tasks'

// ── A scripted model and an in-memory app, so the real tutor loop runs end to end ──
type Reply = Part[] | ((req: ChatRequest) => Part[])
const script: Reply[] = []
const requests: ChatRequest[] = []
const app = vi.hoisted(() => ({ profile: null as any }))

vi.mock('@/state/app', async () => {
  const { createProfile } = await import('@shared/profile')
  app.profile = createProfile('Sam')
  const state = {
    get profile() { return app.profile },
    settings: { benchmarks: {} },
    updateProfile: async (fn: (p: any) => any) => { app.profile = fn(app.profile) }
  }
  return {
    activeProvider: () => ({ id: 'fake', label: 'Fake model', supportsTools: true }),
    useApp: { getState: () => state, subscribe: () => () => {} },
    registerBusy: () => {},
    api: () => ({
      llm: {
        chat: (req: ChatRequest) => {
          requests.push(JSON.parse(JSON.stringify(req)))
          const next = script.shift() ?? [{ type: 'text', text: 'OK.' }]
          const parts = typeof next === 'function' ? next(req) : next
          const message: ChatMessage = { role: 'assistant', parts }
          return { requestId: `r${requests.length}`, done: Promise.resolve({ type: 'done', result: { message, stopReason: 'end', usage: {}, timing: { ttftMs: 1, totalMs: 1 } } }) }
        },
        abort: () => {}
      },
      conversation: { save: async () => {}, get: async () => null }
    })
  }
})

// The tutor module saves the conversation on window close; tests run in Node.
vi.stubGlobal('window', { addEventListener: () => {} })

const { useStudio, DEFAULT_SNAPSHOT } = await import('@/state/studio')
const { computeDerived } = await import('@/state/derived')
const { useTutor } = await import('./tutor')
const { answerQuestion, checkExerciseAsync, gradeOpenQuestion, skipQuestion, unsureQuestion } = await import('./answers')
/** Answer the open card and wait for the tutor's reply (the UI does the same without waiting). */
/** A two-part move question also needs a reason: by default the right one, so tests about the direction stay about the direction. */
const rightReason = () => { const k = useStudio.getState().prediction?.key; return k?.type === 'move' && k.reasons ? k.reasons.choices[k.reasons.correct] : undefined }
const answerNow = async (a: string, sure?: 'sure' | 'unsure' | 'guess', reason = rightReason()) => { const r = gradeOpenQuestion(a, sure, reason); await r.finish?.(); return r.problem }
const { runTool } = await import('./registry')

const ctx = {
  get studio() { return useStudio.getState() },
  derived: () => computeDerived(useStudio.getState().snapshot()),
  profile: () => app.profile,
  updateProfile: async (fn: (p: any) => any) => { app.profile = fn(app.profile) },
  learnerTurns: () => useTutor.getState().learnerTurns,
  session: () => useTutor.getState().session
} as any

const F = 2.4e9
const text = (t: string): Part[] => [{ type: 'text', text: t }]
const call = (name: string, args: Record<string, unknown>, t = ''): Part[] => [...(t ? text(t) : []), { type: 'tool_call', id: `c_${name}_${Math.random()}`, name, args }]
const idle = () => vi.waitFor(() => expect(useTutor.getState().busy).toBe(false))
const lastUserText = (req: ChatRequest) => req.messages.filter((m) => m.role === 'user').at(-1)!.parts.map((p) => (p.type === 'text' ? p.text : p.type === 'tool_result' ? p.content : '')).join('\n')
const allText = (req: ChatRequest) => req.messages.flatMap((m) => m.parts).map((p) => (p.type === 'text' ? p.text : p.type === 'tool_result' ? p.content : '')).join('\n')

beforeEach(async () => {
  const { createProfile, migrateProfile } = await import('@shared/profile')
  app.profile = migrateProfile(createProfile('Sam'))
  script.length = 0
  requests.length = 0
  useTutor.getState().reset()
  useStudio.getState().loadSnapshot({ ...DEFAULT_SNAPSHOT, load: { kind: 'fixed', R: 30, X: 20 } })
})

describe('create_target_task: the tutor designs it, the app makes sure it is possible', () => {
  it('sets a reach task with a reference solution only the tutor sees', async () => {
    const r = await runTool('create_target_task', { title: 'Onto g = 1', instructions: 'One series element.', target: { circle: { family: 'g', value: 1 } }, allowed_kinds: ['seriesL', 'seriesC'] }, ctx)
    expect(r.isError).toBe(false)
    expect(r.content).toMatch(/FOR YOUR VERIFICATION ONLY.*Series [LC]/)
    const ex = useStudio.getState().exercise!
    expect(ex.kind).toBe('reach')
    expect(ex.maxElements).toBe(1)
    expect(ex.showTarget).toBe(true)
  })

  it('refuses an impossible task and leaves the chart exactly as it was', async () => {
    const before = useStudio.getState().snapshot()
    const r = await runTool('create_target_task', { title: 'x', instructions: 'x', target: { circle: { family: 'g', value: 1 } }, allowed_kinds: ['shuntL', 'shuntC'] }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/Not possible/)
    expect(useStudio.getState().snapshot()).toEqual(before)
  })

  it('refuses a target the point already meets, and a bad target shape', async () => {
    const r = await runTool('create_target_task', { title: 'x', instructions: 'x', target: { circle: { family: 'r', value: 0.6 } } }, ctx)
    expect(r.content).toMatch(/already on the r = 0\.6 circle/)
    const bad = await runTool('create_target_task', { title: 'x', instructions: 'x', target: { line: 3 } }, ctx)
    expect(bad.isError).toBe(true)
    expect(bad.content).toMatch(/Give "target"/)
  })

  it('can continue from the learner\'s network (the second half of an L-match)', async () => {
    // First half: a series L that put the point on g = 1.
    const first = findReach(c(30, 20), parseTarget({ circle: { family: 'g', value: 1 } }), ['seriesL'], 1, F, 50).network[0]
    useStudio.getState().addElement('seriesL', first.value)
    const r = await runTool('create_target_task', { title: 'Finish', instructions: 'Now to the centre.', target: { point: { r: 1, x: 0 } }, keep_network: true, max_elements: 2 }, ctx)
    expect(r.isError).toBe(false)
    expect(useStudio.getState().network).toHaveLength(1)
    // Starting from the load instead (two more elements) would also be possible, but one must do here.
    expect(r.content).toMatch(/One solution.*Shunt C/)
  })
})

describe('graded questions: built from the chart, graded by the app', () => {
  it('ask_move: the right choice comes from the move calculator', async () => {
    const r = await runTool('ask_move', { element: { kind: 'shuntC', value: 2e-12 }, from: 'load' }, ctx)
    expect(r.isError).toBe(false)
    const p = useStudio.getState().prediction!
    expect(p.kind).toBe('mcq')
    expect(p.question).toMatch(/Shunt C to the load/)
    expect(r.content).toMatch(/\[right\] "Clockwise along its constant-g circle"/)
  })

  it('ask_move refuses what has no single answer, and end_half without a value', async () => {
    expect((await runTool('ask_move', { element: { kind: 'seriesR', value: 10 } }, ctx)).content).toMatch(/doesn't turn/)
    expect((await runTool('ask_move', { element: { kind: 'shuntC' }, ask: 'end_half' }, ctx)).content).toMatch(/give the element a value/)
  })

  it('ask_locate: a spot given as admittance, or where an element takes the load', async () => {
    await runTool('ask_locate', { question: 'Click y = 1 + j1', point: { g: 1, b: 1 } }, ctx)
    let key = useStudio.getState().prediction!.key!
    expect(key.type === 'locate' && key.targetText).toMatch(/^y = 1 \+ j1/)
    await runTool('ask_locate', { question: 'Where does 2 pF of shunt C take the load?', element: { kind: 'shuntC', value: 2e-12 }, from: 'load' }, ctx)
    key = useStudio.getState().prediction!.key!
    const Z = applyElement(c(30, 20), { id: 'x', kind: 'shuntC', value: 2e-12 }, F)
    const want = gammaFromZ(c(Z.re / 50, Z.im / 50), 1)
    expect(key.type === 'locate' && Math.hypot(key.target.re - want.re, key.target.im - want.im)).toBeLessThan(1e-9)
  })

  it('ask_value refuses an undefined value (VSWR of a short)', async () => {
    useStudio.getState().setLoad({ kind: 'fixed', R: 0, X: 0 })
    const r = await runTool('ask_value', { question: 'VSWR?', quantity: 'vswr', from: 'load' }, ctx)
    expect(r.isError).toBe(true)
  })
})

describe('answering: the learner sees right / not quite; the tutor gets the exact answer', () => {
  it('a typed value: unreadable stays open, then a correct answer is logged and reported', async () => {
    await runTool('ask_value', { question: 'What is the VSWR of the load?', quantity: 'vswr', from: 'load', title: 'VSWR of the load' }, ctx)
    expect(answerQuestion('pretty high')).toMatch(/Write a number/)
    expect(useStudio.getState().prediction).not.toBeNull() // still open
    script.push(text('Spot on.'))
    expect(await answerNow('2.0')).toBeNull()
    expect(useStudio.getState().prediction).toBeNull()
    expect(lastUserText(requests[0])).toMatch(/App grading: CORRECT.*exact value 2\.04/s)
    const items = useTutor.getState().items
    expect(items.find((i) => i.kind === 'user')?.text).toBe('My answer: 2.0 — ✓ correct')
    expect(items.some((i) => /2\.04/.test(i.text) && i.kind === 'user')).toBe(false) // never shown to the learner
    expect(useTutor.getState().session?.exercises.at(-1)).toMatchObject({ kind: 'value', title: 'VSWR of the load', passed: true })
  })

  it('a click: graded from where they clicked', async () => {
    await runTool('ask_locate', { question: 'Click z = 1 − j1', point: { r: 1, x: -1 } }, ctx)
    const g = gammaFromZ(c(1, 1), 1) // the classic sign slip: the upper half
    useStudio.getState().setPrediction({ ...useStudio.getState().prediction!, answered: 'clicked z = 1 + j1', answeredGamma: g })
    script.push(text('Close: which half is capacitive?'))
    await answerNow('clicked z = 1 + j1')
    expect(lastUserText(requests[0])).toMatch(/NOT QUITE: they clicked z = 1 \+ j1.*target is z = 1 − j1/)
    expect(useTutor.getState().session?.exercises.at(-1)).toMatchObject({ kind: 'locate', passed: false })
  })

  it('skipping or "not sure" is never graded or counted', async () => {
    await runTool('ask_move', { element: { kind: 'seriesL' } }, ctx)
    script.push(text('No problem.'))
    skipQuestion()
    await idle()
    expect(lastUserText(requests[0])).toMatch(/\[Question skipped\]/)
    await runTool('ask_move', { element: { kind: 'seriesL' } }, ctx)
    script.push(text('Let us reason it out.'))
    unsureQuestion()
    await idle()
    expect(useTutor.getState().session?.exercises ?? []).toHaveLength(0)
    // Asking for help keeps the card on screen (the tutor goes on to say "pick from the card"),
    // and tells the tutor so; an answer after the help counts as partly theirs.
    const p = useStudio.getState().prediction!
    expect(p).not.toBeNull()
    expect(p.helped).toBe(true)
    expect(lastUserText(requests.at(-1)!)).toMatch(/The card stays open on their screen/)
    script.push(text('Good.'))
    await answerNow(p.choices![p.key!.type === 'move' ? p.key!.correct : 0])
    await idle()
    expect(lastUserText(requests.at(-1)!)).toMatch(/counted as partly right: they had help/)
  })
})

describe('solve, then explain: the follow-up habit', () => {
  /** A reach task, solved on the chart with the app's own reference solution. */
  async function solveTask() {
    await runTool('create_target_task', { title: 'Onto g = 1', instructions: 'One series element.', target: { circle: { family: 'g', value: 1 } }, allowed_kinds: ['seriesL', 'seriesC'] }, ctx)
    const sol = findReach(c(30, 20), parseTarget({ circle: { family: 'g', value: 1 } }), ['seriesL', 'seriesC'], 1, F, 50).network[0]
    useStudio.getState().addElement(sol.kind, sol.value)
  }

  it('a pass hands the tutor the learner\'s verified solution and asks for one follow-up', async () => {
    await solveTask()
    script.push(call('ask_move', { element: { kind: 'seriesL', value: 1e-9 }, from: 'input' }, 'Nice: right onto the circle.'), text('Your call.'))
    const g = await checkExerciseAsync()
    expect(g?.passed).toBe(true)
    await idle()
    const first = lastUserText(requests[0])
    expect(first).toMatch(/\[Task check #1\] PASS/)
    expect(first).toMatch(/\[Their solution, each move verified\]\n1\. Series [LC] .*moves along the constant r = 0\.6 circle/)
    expect(first).toMatch(/\[Follow-up\] They solved it/)
    expect(useStudio.getState().prediction?.followUp).toBe(true) // shown as optional
    expect(useTutor.getState().followUpDue).toBe(false)
  })

  it('praise with no question gets one nudge, and the tutor then asks', async () => {
    await solveTask()
    script.push(text('Great work!'), call('ask_value', { question: 'What is y now?', quantity: 'y' }), text('Have a go.'))
    await checkExerciseAsync()
    expect(lastUserText(requests[1])).toMatch(/you haven't asked your follow-up yet/)
    expect(useStudio.getState().prediction?.key?.type).toBe('value')
  })

  it('a question in the reply counts; no nudge', async () => {
    await solveTask()
    script.push(text('Great work! Why did a series element, and not a shunt one, get you onto g = 1?'))
    await checkExerciseAsync()
    expect(requests).toHaveLength(1)
  })

  it('the lesson can\'t be closed before the follow-up', async () => {
    await solveTask()
    script.push(call('complete_lesson', { can_now_do: ['Move onto g = 1'] }), text('Before we wrap up: what would a bigger L do?'))
    useTutor.setState({ learnerTurns: 3 })
    await checkExerciseAsync()
    expect(allText(requests[1])).toMatch(/first ask your one follow-up question/)
    expect(useTutor.getState().completing).toBe(false)
  })

  it('a model that ignores the nudge is nudged only once (no loop)', async () => {
    await solveTask()
    script.push(text('Great work!'), text('Really great.'))
    await checkExerciseAsync()
    expect(requests).toHaveLength(2)
  })

  it('only the first pass triggers it, and a failed check never does', async () => {
    await solveTask()
    script.push(text('Why does it work?'))
    await checkExerciseAsync()
    script.push(text('Still good.'))
    await checkExerciseAsync() // checked again after passing
    expect(lastUserText(requests[1])).not.toMatch(/Follow-up/)
    expect(requests).toHaveLength(2)
    useStudio.getState().clearNetwork()
    await runTool('create_target_task', { title: 'Again', instructions: 'x', target: { circle: { family: 'g', value: 1 } } }, ctx)
    script.push(text('Not yet: look at which circle you are on.'))
    await checkExerciseAsync()
    expect(lastUserText(requests[2])).toMatch(/NOT YET/)
    expect(requests).toHaveLength(3)
  })
})

describe('reach tasks are graded on where the point really is', () => {
  it('passes on the target within tolerance, fails off it or with a forbidden element', async () => {
    await runTool('create_target_task', { title: 't', instructions: 't', target: { circle: { family: 'g', value: 1 } }, allowed_kinds: ['seriesL', 'seriesC'] }, ctx)
    const { gradeExercise } = await import('@/state/exercise')
    const ex = () => useStudio.getState().exercise!
    expect(gradeExercise(ex()).passed).toBe(false)
    const sol = findReach(c(30, 20), parseTarget({ circle: { family: 'g', value: 1 } }), ['seriesL'], 1, F, 50).network[0]
    useStudio.getState().addElement('seriesL', sol.value)
    expect(gradeExercise(ex()).summary).toMatch(/^PASS — point at 2\.4 GHz: g = 1/)
    // Graded on where the point lands, not the part value: 30% more L still sits on the circle (g ≈ 0.96),
    // twice the L is clearly off it (g ≈ 0.86).
    const id = useStudio.getState().network[0].id
    useStudio.getState().updateElement(id, { value: sol.value * 1.3 })
    expect(gradeExercise(ex()).passed).toBe(true)
    useStudio.getState().updateElement(id, { value: sol.value * 2 })
    expect(gradeExercise(ex()).summary).toMatch(/^NOT YET — point at 2\.4 GHz: g = 0\.86/)
    // A shunt element isn't allowed here even if it landed somewhere useful.
    useStudio.getState().updateElement(id, { value: sol.value })
    useStudio.getState().addElement('shuntC', 1e-15)
    expect(gradeExercise(ex()).summary).toMatch(/max 1|not allowed/)
    const z = inputImpedance(c(30, 20), useStudio.getState().network, F)
    expect(z.re).toBeGreaterThan(0)
  })
})

describe('fixes from the live Gemini run', () => {
  const WRONG = 'Remember, capacitors (both series and shunt) move the point **counter-clockwise**, while inductors move it **clockwise**.'

  it('a wrong direction rule is withdrawn and rewritten, even after what_if was called', async () => {
    script.push(
      [...call('what_if', { elements: [{ kind: 'shuntC', value: 2e-12 }] })],
      text(WRONG),
      text('A shunt C moves the point clockwise along its constant-g circle; a series C moves it counter-clockwise along its constant-r circle.')
    )
    await useTutor.getState().send('Which way do capacitors move the point?')
    const tutorSaid = useTutor.getState().items.filter((i) => i.kind === 'tutor').map((i) => i.text)
    expect(tutorSaid).toEqual(['A shunt C moves the point clockwise along its constant-g circle; a series C moves it counter-clockwise along its constant-r circle.'])
    expect(lastUserText(requests[2])).toMatch(/gets a direction wrong.*shunt C moves it clockwise/s)
    expect(useTutor.getState().session?.transcript.some((t) => /both series and shunt/.test(t.text))).toBe(false)
  })

  it('a model that keeps getting it wrong is shown with a plain correction from the app', async () => {
    script.push(text(WRONG), text(WRONG), text(WRONG))
    await useTutor.getState().send('Which way do capacitors move the point?')
    const items = useTutor.getState().items
    expect(items.filter((i) => i.kind === 'tutor')).toHaveLength(1)
    expect(items.at(-1)).toMatchObject({ kind: 'system' })
    expect(items.at(-1)!.text).toMatch(/^Correction from the app: A shunt C moves it clockwise/)
    expect(requests).toHaveLength(3) // two rewrites, then shown: no endless loop
  })

  it('"Give me one more, a bit harder" never ends the lesson', async () => {
    useTutor.setState({ learnerTurns: 4 })
    await useTutor.getState().send('Hi')
    script.push(call('complete_lesson', { can_now_do: ['Match a load'] }), call('create_target_task', { title: 'Harder', instructions: 'Reach the real axis using only a line.', target: { circle: { family: 'x', value: 0 } }, allowed_kinds: ['tline'] }), text('Here you go.'))
    await useTutor.getState().send('Nice. Give me one more, a bit harder.')
    expect(allText(requests.at(-2)!)).toMatch(/The learner just asked for more/)
    expect(useTutor.getState().completing).toBe(false)
    expect(useStudio.getState().exercise?.title).toBe('Harder')
  })
})

describe('fixes from the second live Gemini run', () => {
  const META = ' You can use annotations to show it.\n\nThis response is hidden from the learner. Retry now.'

  it('a reply about the machinery is never shown; the tutor is asked to answer properly', async () => {
    script.push(text(META), text('Here is the idea: watch the point as you add it.'))
    await useTutor.getState().send('Show me?')
    const items = useTutor.getState().items
    expect(items.some((i) => /hidden from the learner|Retry now/.test(i.text))).toBe(false)
    expect(items.filter((i) => i.kind === 'tutor').map((i) => i.text)).toEqual(['Here is the idea: watch the point as you add it.'])
    expect(useTutor.getState().session?.transcript.some((t) => /Retry now/.test(t.text))).toBe(false)
    expect(lastUserText(requests[1])).toMatch(/not addressed to the learner/)
  })

  it('a model stuck on such replies stops after two tries, showing nothing', async () => {
    script.push(text(META), text(META), text(META), text(META))
    await useTutor.getState().send('Show me?')
    expect(useTutor.getState().items.filter((i) => i.kind === 'tutor')).toHaveLength(0)
    expect(requests).toHaveLength(3)
  })

  it('a card tool that failed can be retried in the same turn (it was refused before)', async () => {
    useStudio.getState().addElement('seriesL', 2.28e-9)
    useStudio.getState().addElement('shuntC', 1.08e-12)
    script.push(
      [
        // Gemini's first try: max_elements 1 with two elements already kept.
        ...call('create_target_task', { title: 'Alt', instructions: 'x', target: { point: { r: 1, x: 0 } }, keep_network: true, max_elements: 1, allowed_kinds: ['seriesC'] }),
        ...call('create_target_task', { title: 'Alt', instructions: 'Start from the load: shunt L first, then one more.', target: { point: { r: 1, x: 0 } }, keep_network: false, max_elements: 2, allowed_kinds: ['shuntL', 'seriesC'] })
      ],
      text('Over to you.')
    )
    await useTutor.getState().send('Give me one more.')
    const results = requests[1].messages.at(-1)!.parts.filter((p) => p.type === 'tool_result') as Array<{ content: string; isError?: boolean }>
    expect(results[0].isError).toBe(true)
    expect(results[0].content).toMatch(/counts the whole network.*use max_elements 3/)
    expect(results[1].isError).toBeFalsy()
    expect(useStudio.getState().exercise?.title).toBe('Alt')
  })

  it('but two cards in one turn are still refused', async () => {
    script.push(
      [...call('ask_move', { element: { kind: 'seriesL' } }), ...call('ask_value', { question: 'VSWR?', quantity: 'vswr' })],
      text('Your turn.')
    )
    await useTutor.getState().send('Quiz me')
    const results = requests[1].messages.at(-1)!.parts.filter((p) => p.type === 'tool_result') as Array<{ content: string; isError?: boolean }>
    expect(results[1].content).toMatch(/Already done this turn/)
    expect(useStudio.getState().prediction?.key?.type).toBe('move')
  })
})

describe('the meta-reply filter does not eat real teaching', () => {
  it('ordinary replies pass', async () => {
    const { isMetaReply } = await import('./verify')
    expect(isMetaReply('Nice! The shunt C moved you clockwise onto the centre. What would a bigger C do?')).toBe(false)
    expect(isMetaReply('Your system impedance is 50 Ω; the load is 30 − j9.9 Ω.')).toBe(false)
    expect(isMetaReply('This response is hidden from the learner. Retry now.')).toBe(true)
    expect(isMetaReply('[System] Please reply.')).toBe(true)
  })
})


describe('memory: graded answers update the learner model by themselves', () => {
  it('a wrong move answer: skill, topic and the exact misconception are recorded; the tutor is told and can\'t double-record', async () => {
    const before = app.profile.skills.lumped_moves.mastery
    const r = await runTool('ask_move', { element: { kind: 'shuntC', value: 2e-12 }, from: 'load' }, ctx)
    expect(r.content).toMatch(/Practises: which way a shunt C moves the point \(dir_shuntC\), level 2; their aim for it is 1 \(harder than their aim: a stretch; expect to support them\)/)
    expect(app.profile.asked.at(-1)).toMatchObject({ topic: 'dir_shuntC', kind: 'move' })
    script.push(call('record_evidence', { skill: 'lumped_moves', outcome: 'incorrect', difficulty: 1, reason: 'wrong', transfer: false }), text('Which way does adding capacitance push b?'))
    await answerNow('Counter-clockwise along its constant-g circle')
    expect(app.profile.skills.lumped_moves.mastery).toBeLessThan(before)
    expect(app.profile.topics.dir_shuntC).toMatchObject({ seen: 1, correct: 0, level: 1 })
    expect(app.profile.misconceptions).toHaveLength(1)
    expect(app.profile.misconceptions[0]).toMatchObject({ topic: 'dir_shuntC', description: 'Thinks a shunt C moves the point counter-clockwise along its constant-g circle (it moves clockwise along its constant-g circle)' })
    expect(lastUserText(requests[0])).toMatch(/\[Learner memory\] Recorded automatically .*lumped_moves 0\.30 → 0\.\d+/)
    // The tutor tried to record the same answer again: refused.
    expect(allText(requests[1])).toMatch(/already recorded lumped_moves from that graded answer/)
    expect(app.profile.skills.lumped_moves.evidence).toBe(1)
  })

  it('the next turn, the tutor may record its own observation again', async () => {
    useTutor.setState({ learnerTurns: 2 })
    script.push(call('record_evidence', { skill: 'lumped_moves', outcome: 'partial', difficulty: 2, reason: 'right', transfer: false, note: 'explained the g circle well' }), text('Good reasoning.'))
    await useTutor.getState().send('Shunt elements keep g constant because they add susceptance only.')
    expect(allText(requests[1])).toMatch(/mastery_after/)
  })

  it('a passed task records its topic (and only the first pass counts)', async () => {
    await runTool('create_target_task', { title: 'Onto g = 1', instructions: 'x', target: { circle: { family: 'g', value: 1 } }, allowed_kinds: ['seriesL', 'seriesC'] }, ctx)
    const sol = findReach(c(30, 20), parseTarget({ circle: { family: 'g', value: 1 } }), ['seriesL', 'seriesC'], 1, F, 50).network[0]
    useStudio.getState().addElement(sol.kind, sol.value)
    script.push(text('Why does it work?'), text('Still right.'))
    await checkExerciseAsync()
    await checkExerciseAsync()
    expect(app.profile.topics.reach_lumped).toMatchObject({ seen: 1, correct: 1 })
  })

  it('giving up on a task counts as a miss for its topic', async () => {
    await runTool('create_exercise', { title: 'Match it', instructions: 'x', freq_hz: F, max_vswr: 1.5 }, ctx)
    useTutor.setState({ learnerTurns: 2 })
    const r = await runTool('close_exercise', { outcome: 'given_up' }, { ...ctx, recordExercise: () => {} })
    expect(r.content).toMatch(/Recorded automatically/)
    expect(app.profile.topics.l_match).toMatchObject({ seen: 1, correct: 0 })
  })

  it('the brief the tutor plans from reflects it', async () => {
    await runTool('ask_move', { element: { kind: 'seriesC' } }, ctx)
    script.push(text('Let us look again.'))
    await answerNow('Clockwise along its constant-r circle')
    const { buildSystemPrompt } = await import('./prompt')
    const dyn = buildSystemPrompt(app.profile, null).dynamic
    expect(dyn).toMatch(/Weak topics: dir_seriesC/)
    expect(dyn).toMatch(/Live misconceptions: \[mc_[^\]]+\] Thinks a series C moves the point clockwise along its constant-r circle/)
    expect(dyn).toMatch(/Recently asked \(vary; don't repeat\): move\/dir_seriesC L2/)
  })

  it('notes: categorised, updated in place, forgettable', async () => {
    useTutor.setState({ learnerTurns: 1 })
    const a = await runTool('save_note', { note: 'Working on a 2.4 GHz patch antenna in CST', category: 'goal' }, ctx)
    const id = /Saved as (\S+)\./.exec(a.content)![1]
    const b = await runTool('save_note', { note: 'Now on a 5.8 GHz patch antenna in CST', category: 'goal', replaces: id }, ctx)
    expect(b.content).toBe(`Updated note ${id}.`)
    expect(app.profile.notes).toHaveLength(1)
    expect((await runTool('forget_note', { id }, ctx)).isError).toBe(false)
    expect((await runTool('forget_note', { id }, ctx)).content).toMatch(/No note with id/)
  })

  it('a misconception logged with a topic merges with the one the app recorded', async () => {
    await runTool('ask_move', { element: { kind: 'seriesL' } }, ctx)
    script.push(text('Hmm.'))
    await answerNow('Counter-clockwise along its constant-r circle')
    useTutor.setState({ learnerTurns: 3 })
    const r = await runTool('log_misconception', { skill: 'lumped_moves', topic: 'dir_seriesL', description: 'Thinks a series L turns counter-clockwise' }, ctx)
    expect(JSON.parse(r.content)).toMatchObject({ times_seen: 2 })
    expect(app.profile.misconceptions).toHaveLength(1)
    expect(app.profile.misconceptions[0].description).toBe('Thinks a series L turns counter-clockwise')
  })
})


describe('fixes from the memory live run', () => {
  it('Gemini\'s stray fragments are never shown (" You must do this to continue.")', async () => {
    const { isMetaReply } = await import('./verify')
    expect(isMetaReply(' You must do this to continue.')).toBe(true)
    expect(isMetaReply(' You can use annotations to show it.')).toBe(true)
    expect(isMetaReply('You can try a shunt C next: which way will it move?')).toBe(false) // a real, short reply
    expect(isMetaReply('Spot on! Now continue to the centre with your second element.')).toBe(false)
    script.push(text(' You must do this to continue.'), text('Over to you: answer the card.'))
    await useTutor.getState().send('Another one please.')
    expect(useTutor.getState().items.filter((i) => i.kind === 'tutor').map((i) => i.text)).toEqual(['Over to you: answer the card.'])
  })

  it('a wrong answer on a series inductor (however the question words it) keeps the learner\'s own misconception wording', async () => {
    app.profile = { ...app.profile, misconceptions: [{ id: 'real', skill: 'lumped_moves', description: "Thinks series L moves the point counter-clockwise along the constant-r circle (it's clockwise).", count: 1, firstSeen: 'x', lastSeen: 'x', resolved: false }] }
    await runTool('ask_move', { element: { kind: 'seriesL' }, question: "Let's start with a classic. If you add a series inductor to the load, which way will the point move?" }, ctx)
    script.push(text('Close.'))
    await answerNow('Counter-clockwise along its constant-r circle')
    expect(app.profile.misconceptions).toHaveLength(1)
    expect(app.profile.misconceptions[0]).toMatchObject({ id: 'real', topic: 'dir_seriesL', count: 2, description: "Thinks series L moves the point counter-clockwise along the constant-r circle (it's clockwise)." })
  })
})

describe('after a card, the card is the reply', () => {
  it('an empty reply ends the turn quietly (no "please reply" nudge), and the next message keeps turns alternating', async () => {
    script.push(call('ask_move', { element: { kind: 'shuntL', value: 6e-9 }, from: 'load' }, ''), text(''))
    await useTutor.getState().send('Quiz me')
    await idle()
    expect(requests).toHaveLength(2)
    expect(allText(requests[1])).not.toMatch(/Please reply to the learner/)
    expect(useTutor.getState().items.filter((i) => i.kind === 'tutor')).toHaveLength(0)
    script.push(text('Sure.'))
    unsureQuestion()
    await idle()
    const roles = requests.at(-1)!.messages.map((m) => m.role)
    expect(roles.some((r, i) => i > 0 && r === roles[i - 1])).toBe(false)
  })

  it('a bracketed aside after the card is dropped; a real line is kept', async () => {
    script.push(call('ask_move', { element: { kind: 'shuntL', value: 6e-9 }, from: 'load' }), text("(I've just posted a quick question on the screen!)"))
    await useTutor.getState().send('Quiz me')
    await idle()
    expect(useTutor.getState().items.filter((i) => i.kind === 'tutor')).toHaveLength(0)
    skipQuestion()
    await idle()
    script.push(call('ask_move', { element: { kind: 'shuntL', value: 6e-9 }, from: 'load' }), text('Take your time: think about which circle it rides on.'))
    await useTutor.getState().send('Another')
    await idle()
    expect(useTutor.getState().items.filter((i) => i.kind === 'tutor').map((i) => i.text)).toContain('Take your time: think about which circle it rides on.')
  })
})

describe('help is noticed: the answer then counts as partly theirs', () => {
  it('typing to the tutor while a question is open marks it helped, and a right answer is recorded as partly right', async () => {
    await runTool('ask_move', { element: { kind: 'shuntC', value: 2e-12 }, from: 'load' }, ctx)
    script.push(text('Think about which circle a shunt part follows.'))
    await useTutor.getState().send('which way is it?')
    await idle()
    expect(useStudio.getState().prediction!.helped).toBe(true)
    // The tutor is reminded the card is still theirs to answer.
    expect(lastUserText(requests.at(-1)!)).toMatch(/A question card is still open, unanswered: .*Don't state or imply the card's answer/s)
    const p = useStudio.getState().prediction!
    script.push(text('Good.'))
    await answerNow(p.choices![p.key!.type === 'move' ? p.key!.correct : 0])
    await idle()
    expect(lastUserText(requests.at(-1)!)).toMatch(/counted as partly right: they had help/)
    expect(app.profile.topics.dir_shuntC.rightIn).toHaveLength(0)
  })

  it('a task passed on the first check, alone, is fully theirs; after several checks, partly', async () => {
    const solve = async () => {
      const r = await runTool('create_target_task', { title: 'Onto g = 1', instructions: 'One series element.', target: { circle: { family: 'g', value: 1 } }, allowed_kinds: ['seriesL', 'seriesC'] }, ctx)
      expect(r.isError).toBe(false)
      return findReach(c(30, 20), parseTarget({ circle: { family: 'g', value: 1 } }), ['seriesL', 'seriesC'], 1, F, 50).network[0]
    }
    const el = await solve()
    useStudio.getState().addElement(el.kind, el.value)
    script.push(text('Nice.'), text('Why does it work?'))
    await checkExerciseAsync()
    await idle()
    expect(lastUserText(requests.at(-2) ?? requests.at(-1)!)).not.toMatch(/partly right/)
    // Again, but with a wrong first check.
    useStudio.getState().loadSnapshot({ ...DEFAULT_SNAPSHOT, load: { kind: 'fixed', R: 30, X: 20 } })
    const el2 = await solve()
    script.push(text('Not yet.'))
    await checkExerciseAsync()
    await idle()
    useStudio.getState().addElement(el2.kind, el2.value)
    requests.length = 0
    script.push(text('Nice.'), text('Why?'))
    await checkExerciseAsync()
    await idle()
    expect(lastUserText(requests[0])).toMatch(/counted as partly right: they had help/)
  })
})

describe('how sure they were reaches the tutor and the memory', () => {
  it('the tutor sees "(they said: not sure)" and the fragile-right note; the calibration log grows', async () => {
    await runTool('ask_move', { element: { kind: 'shuntC', value: 2e-12 }, from: 'load' }, ctx)
    const p = useStudio.getState().prediction!
    script.push(text('Right!'))
    const r = gradeOpenQuestion(p.choices![(p.key as any).correct], 'unsure', rightReason())
    await r.finish!()
    await idle()
    const said = lastUserText(requests.at(-1)!)
    expect(said).toMatch(/\(they said: not sure\)/)
    expect(said).toMatch(/weren't sure: it comes back for review soon/)
    expect(app.profile.calibration).toEqual([expect.objectContaining({ sure: 'unsure', right: true, topic: 'dir_shuntC' })])
  })
})

describe('questions that dig: why, spot the mistake, situations, check yourself', () => {
  it('right direction, wrong reason: partly right, and the wrong idea is recorded as a misconception', async () => {
    await runTool('ask_move', { element: { kind: 'seriesL', value: 3e-9 }, from: 'load' }, ctx)
    const p = useStudio.getState().prediction!
    const k = p.key as Extract<NonNullable<typeof p.key>, { type: 'move' }>
    expect(k.reasons!.choices).toHaveLength(4)
    expect(p.graded).toMatchObject({ topic: 'dir_seriesL', difficulty: 2, ctx: 'from the upper half' })
    const wrongWhy = k.reasons!.choices.find((x) => /−jx/.test(x))!
    script.push(text('Close.'))
    await answerNow(k.choices[k.correct], 'sure', wrongWhy)
    await idle()
    expect(lastUserText(requests.at(-1)!)).toMatch(/RIGHT ANSWER, WRONG REASON/)
    expect(app.profile.misconceptions.map((m: any) => m.description)).toContain('Thinks a series L adds −jx in series (x down, r fixed)')
    expect(app.profile.topics.dir_seriesL.rightIn).toHaveLength(0)
  })

  it('ask_spot_error: the app plants the mistake; missing it records what they accepted', async () => {
    const r = await runTool('ask_spot_error', { mistake: 'direction' }, ctx)
    expect(r.isError).toBe(false)
    expect(r.content).toMatch(/a mistake in Step 2/)
    const p = useStudio.getState().prediction!
    expect(p.key!.type).toBe('pick')
    expect(p.question).toMatch(/\*\*Step 4\.\*\*/)
    expect(p.graded!.ctx).toBe('spot the mistake: direction')
    script.push(text('Look again at step 2.'))
    await answerNow("No mistake: it's all right", 'sure')
    await idle()
    expect(lastUserText(requests.at(-1)!)).toMatch(/NOT QUITE/)
    const mc = app.profile.misconceptions.at(-1)
    expect(mc.description).toMatch(/^Accepts that a series [LC] turns the point/)
    expect(mc.confident).toBe(true)
  })

  it('every graded item carries its situation, so variety can be checked', async () => {
    await runTool('ask_locate', { question: 'Click z = 2 - j1', point: { r: 2, x: -1 } }, ctx)
    expect(useStudio.getState().prediction!.graded!.ctx).toBe('lower half, r ≥ 1, given as z')
    await runTool('ask_value', { question: 'VSWR?', quantity: 'vswr' }, ctx)
    expect(useStudio.getState().prediction!.graded!.ctx).toBe('vswr, upper half, r < 1')
    useStudio.getState().setPrediction(null)
    await runTool('create_target_task', { title: 't', instructions: 'i', target: { circle: { family: 'g', value: 1 } }, allowed_kinds: ['seriesL', 'seriesC'] }, ctx)
    expect(useStudio.getState().exercise!.graded!.ctx).toBe('upper half, r < 1 → a g circle')
  })

  it('reaching the goal keeps the lesson open to read back; the learner finishes it or keeps going (flagged)', async () => {
    const { buildSystemPrompt } = await import('./prompt')
    useTutor.setState({ learnerTurns: 4 })
    await useTutor.getState().send('Hi')
    const id = useTutor.getState().session!.id
    app.profile = { ...app.profile, nextFocus: { picks: [], at: 'x', session: id } }
    script.push(call('complete_lesson', { can_now_do: ['Match a load'] }), text('Well done: you matched it and explained why.'))
    await useTutor.getState().send('I matched it, and the shunt C moved it onto g = 1.')
    // Still open, with the conversation on screen: nothing was summarised or cleared.
    const s = useTutor.getState().session!
    expect(s.goalReachedAt).toBeTruthy()
    expect(useTutor.getState().history.length).toBeGreaterThan(0)
    expect(useTutor.getState().lastEnded).toBeNull()
    expect(buildSystemPrompt(app.profile, s).dynamic).toMatch(/GOAL REACHED: you gave the recap/)
    // Keep going: the tutor follows their lead and doesn't close it again.
    useTutor.getState().keepGoing()
    expect(buildSystemPrompt(app.profile, useTutor.getState().session).dynamic).toMatch(/chose to keep going/)
    expect((await runTool('complete_lesson', { can_now_do: ['x'] }, ctx)).content).toMatch(/already marked reached/)
    // Finishing it later still counts the goal as reached.
    script.push(text('Summary.'))
    await useTutor.getState().endSession()
    expect(useTutor.getState().lastEnded?.outcome).toBe('completed')
  })

  it("a new lesson starts without the last lesson's drawings or zoom", async () => {
    useStudio.getState().setAnnotations(() => [{ id: 'old', kind: 'point', gamma: { re: 0, im: 0 }, label: 'after series C' }])
    useStudio.getState().setView({ cx: 0.2, cy: 0, half: 0.3 }, 'tutor', 'old zoom')
    script.push(text('Hello.'))
    await useTutor.getState().startSession()
    await idle()
    expect(useStudio.getState().annotations).toEqual([])
    expect(useStudio.getState().tutorView).toBeNull()
  })

  it('a check-yourself lesson verifies instead of teaching, on the skills with the least proof', async () => {
    app.profile = { ...app.profile, skills: { ...app.profile.skills, chart_basics: { mastery: 0.8, confidence: 0.5, evidence: 4, history: [] } } }
    script.push(text('This is a quick check: no teaching, just questions.'))
    await useTutor.getState().startSession('probe')
    await idle()
    const opening = lastUserText(requests[0])
    expect(opening).toMatch(/Check-yourself session/)
    expect(opening).toMatch(/chart_basics \(provisional; still needs/)
    expect(opening).toMatch(/ask_spot_error/)
    expect(useTutor.getState().session!.focus).toBe('probe')
  })
})

describe('patterns: the same confusion across topics reaches the tutor', () => {
  it('a mirrored click, then a shunt move on the wrong circle: two topics, one confusion, a NEW PATTERN for the tutor', async () => {
    // 1. Click y = 1 + j1 ... they click the z point instead (mirrored through the centre).
    await runTool('ask_locate', { question: 'Click y = 1 + j1', point: { g: 1, b: 1 } }, ctx)
    const target = (useStudio.getState().prediction!.key as any).target
    useStudio.getState().setPrediction({ ...useStudio.getState().prediction!, answeredGamma: c(-target.re, -target.im) })
    script.push(text('Not quite.'))
    await answerNow('clicked', 'sure')
    await idle()
    expect(lastUserText(requests.at(-1)!)).toMatch(/slip: clicked the point mirrored through the centre \(the admittance point\) \(z_vs_y\)/)
    expect(lastUserText(requests.at(-1)!)).not.toMatch(/NEW PATTERN/)
    // 2. Then a shunt question answered with the series reason ("adds +jx in series").
    await runTool('ask_move', { element: { kind: 'shuntC', value: 2e-12 }, from: 'load' }, ctx)
    const k = useStudio.getState().prediction!.key as any
    script.push(text('Hmm.'))
    await answerNow(k.choices[2], 'sure', k.reasons.choices[k.reasons.ids.indexOf('sx_up')])
    await idle()
    // series_vs_shunt once only; but z_vs_y? Not from this answer. Add a third, a y read as z, in another topic:
    await runTool('ask_value', { question: 'What is y at the load?', quantity: 'y' }, ctx)
    script.push(text('Close, but that is z.'))
    await answerNow('0.6 + j0.4', 'sure')
    await idle()
    const said = lastUserText(requests.at(-1)!)
    expect(said).toMatch(/NEW PATTERN: Mixes up impedance and admittance \(z and y\), seen 2× in 2 topic\(s\)/)
    // The brief now leads with it, and the slips are kept.
    expect(JSON.stringify(requests.at(-1)!.system)).toMatch(/Patterns \(the same confusion across topics or lessons; work on these first\): z_vs_y \[still there, 0\/2\]/)
    expect(app.profile.slips.map((x: any) => x.confusion)).toEqual(['z_vs_y', 'series_vs_shunt', 'z_vs_y'])
  })

  it('a wrong guess shows a gap, not a confusion: no slip', async () => {
    await runTool('ask_value', { question: 'What is y at the load?', quantity: 'y' }, ctx)
    script.push(text('No.'))
    await answerNow('0.6 + j0.4', 'guess')
    await idle()
    expect(app.profile.slips ?? []).toEqual([])
  })

  it('the tutor can add what it hears in conversation to the same record', async () => {
    useTutor.setState({ learnerTurns: 2 })
    const r = await runTool('log_misconception', { skill: 'admittance', topic: 'read_y', confusion: 'z_vs_y', description: 'Said a shunt C adds +jx' }, ctx)
    expect(r.isError).toBe(false)
    expect(app.profile.slips).toEqual([expect.objectContaining({ confusion: 'z_vs_y', source: 'tutor', topic: 'read_y', detail: 'in conversation: Said a shunt C adds +jx' })])
  })
})

describe('robustness: what the QA pass found', () => {
  it('a typed answer while the tutor is still writing is not graded (it would never reach the tutor)', async () => {
    await runTool('ask_value', { question: 'VSWR?', quantity: 'vswr' }, ctx)
    useTutor.setState({ busy: true })
    expect(gradeOpenQuestion('2', 'sure').problem).toMatch(/tutor is still writing/)
    expect(useStudio.getState().prediction).not.toBeNull()
    expect(app.profile.topics?.gamma_vswr).toBeUndefined()
    useTutor.setState({ busy: false })
  })

  it('pressing Check twice sends one check, and the first pass keeps its solution and follow-up', async () => {
    await runTool('create_target_task', { title: 'Onto g = 1', instructions: 'One series element.', target: { circle: { family: 'g', value: 1 } }, allowed_kinds: ['seriesL', 'seriesC'] }, ctx)
    const el = findReach(c(30, 20), parseTarget({ circle: { family: 'g', value: 1 } }), ['seriesL', 'seriesC'], 1, F, 50).network[0]
    useStudio.getState().addElement(el.kind, el.value)
    script.push(text('Nice. Why does it work?'))
    const [a, b] = [checkExerciseAsync(), checkExerciseAsync()]
    await Promise.all([a, b])
    await idle()
    const checks = requests.filter((r) => /\[Task check #/.test(lastUserText(r)))
    expect(checks).toHaveLength(1)
    expect(lastUserText(checks[0])).toMatch(/\[Their solution, each move verified\]/)
  })

  it('a repeated read after the chart changed gets fresh data, not the cached result', async () => {
    script.push(
      call('get_chart_state', {}),
      call('set_scenario', { load: { kind: 'fixed', R: 100, X: 0 } }),
      call('get_chart_state', {}),
      text('Done.')
    )
    await useTutor.getState().send('look at it')
    await idle()
    const results = requests.flatMap((r) => r.messages).flatMap((m) => m.parts).filter((x: any) => x.type === 'tool_result' && x.name === 'get_chart_state').map((x: any) => x.content)
    expect(results.at(-1)).not.toMatch(/Same call already made/)
    expect(results.at(-1)).toMatch(/100/)
  })

  it('record_evidence is allowed again in a new lesson at the same turn number', async () => {
    const lessonCtx = (id: string) => ({ ...ctx, session: () => ({ id }), learnerTurns: () => 3, autoRecorded: () => false })
    expect((await runTool('record_evidence', { skill: 'reflection', outcome: 'correct', difficulty: 2, reason: 'none', transfer: false }, lessonCtx('lesson-a'))).isError).toBe(false)
    expect((await runTool('record_evidence', { skill: 'reflection', outcome: 'correct', difficulty: 2, reason: 'none', transfer: false }, lessonCtx('lesson-a'))).isError).toBe(true)
    expect((await runTool('record_evidence', { skill: 'reflection', outcome: 'correct', difficulty: 2, reason: 'none', transfer: false }, lessonCtx('lesson-b'))).isError).toBe(false)
  })

  it('a bad override or outcome from a model never reaches the record', async () => {
    const lessonCtx = { ...ctx, session: () => ({ id: 'l' }), learnerTurns: () => 5, autoRecorded: () => false }
    expect((await runTool('set_skill_level', { skill: 'reflection', mastery: 'high', reason: 'x' }, lessonCtx)).isError).toBe(true)
    expect((await runTool('record_evidence', { skill: 'admittance', outcome: 'great', difficulty: 2 }, lessonCtx)).isError).toBe(true)
    expect(Number.isFinite(app.profile.skills.reflection.mastery)).toBe(true)
  })

  it('a long run of cards still sends a history that starts with the learner', async () => {
    // 40 card turns: every user turn after the first carries tool results.
    const h: any[] = [{ role: 'user', parts: [{ type: 'text', text: 'start' }] }]
    for (let i = 0; i < 40; i++) {
      h.push({ role: 'assistant', parts: [{ type: 'tool_call', id: `c${i}`, name: 'ask_move', args: {} }] })
      h.push({ role: 'user', parts: [{ type: 'tool_result', callId: `c${i}`, name: 'ask_move', content: 'shown' }, { type: 'text', text: `answer ${i}` }] })
    }
    useTutor.setState({ history: h })
    script.push(text('Next.'))
    await useTutor.getState().send('next')
    await idle()
    const sent = requests.at(-1)!.messages
    expect(sent[0].role).toBe('user')
    expect(sent[0].parts.some((x: any) => x.type === 'tool_result')).toBe(false)
    // Every tool result that is sent still has its call.
    const calls = new Set(sent.flatMap((m) => m.parts).filter((x: any) => x.type === 'tool_call').map((x: any) => x.id))
    for (const r of sent.flatMap((m) => m.parts).filter((x: any) => x.type === 'tool_result')) expect(calls.has((r as any).callId)).toBe(true)
  })

  it('a reply that spoke and set a card ends the turn: no second message from the tutor', async () => {
    script.push([...text('Here is one for you.'), ...call('ask_move', { element: { kind: 'shuntC', value: 2e-12 }, from: 'load' })], text('(this should never be asked for)'))
    const before = requests.length
    await useTutor.getState().send('quiz me')
    await idle()
    expect(requests.length - before).toBe(1)
  })

  it('"thanks again" is not a request for more; a real request holds complete_lesson back only once', async () => {
    const { MORE_PRACTICE } = await import('./tools/lesson')
    for (const t of ['Got it, thanks again!', 'That was harder than I thought, thanks.', 'Another great lesson.']) expect(MORE_PRACTICE.test(t), t).toBe(false)
    for (const t of ['Can you make it harder?', 'Give me another one', 'Let us try that again', 'again?']) expect(MORE_PRACTICE.test(t), t).toBe(true)
  })

  it('ask_prediction refuses a multiple-choice card with no choices (from a live run)', async () => {
    const r = await runTool('ask_prediction', { question: 'Which way?', kind: 'mcq' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/at least two options/)
    expect(useStudio.getState().prediction).toBeNull()
  })

  it('no angle-of-Γ question at the matched point', async () => {
    const r = await runTool('ask_value', { question: 'Angle?', quantity: 'gamma_angle_deg', from_point: { r: 1, x: 0 } }, ctx)
    expect(r.content).toMatch(/has no angle/)
  })
})

describe('ask_component: the step from the chart to a real part, graded', () => {
  const W = 2 * Math.PI * F
  it('series x = −1.2: a capacitor of 1/(ω·60 Ω); the unit says which part; slips are named', async () => {
    const r = await runTool('ask_component', { question: 'What part and value adds x = −1.2 in series?', connection: 'series', amount: -1.2 }, ctx)
    expect(r.isError).toBe(false)
    expect(r.content).toMatch(/series C = 1\.1\d? pF/)
    const p = useStudio.getState().prediction!
    expect(p.graded).toMatchObject({ topic: 'part_value', difficulty: 2, ctx: 'series, negative x' })
    const C = 1 / (W * 60)
    expect(gradeOpenQuestion('1.1').problem).toMatch(/with its unit/)
    // Forgot the 2π: off by 2π, a classic slip.
    script.push(text('Close: check ω.'))
    await answerNow(`${(C * 2 * Math.PI * 1e12).toFixed(2)} pF`, 'sure')
    await idle()
    expect(lastUserText(requests.at(-1)!)).toMatch(/NOT QUITE: they answered a capacitor/)
    expect(app.profile.slips.at(-1)).toMatchObject({ confusion: 'two_pi', topic: 'part_value' })
  })

  it('the right part and value is correct; an inductor where a capacitor is needed is the sign slip', async () => {
    await runTool('ask_component', { question: 'Shunt part for b = +0.8?', connection: 'shunt', amount: 0.8 }, ctx)
    const C = 0.8 / (50 * W)
    script.push(text('Right.'))
    await answerNow(`${(C * 1e12).toFixed(3)}pF`, 'sure')
    await idle()
    expect(lastUserText(requests.at(-1)!)).toMatch(/CORRECT: they answered a capacitor/)
    await runTool('ask_component', { question: 'Shunt part for b = +0.8?', connection: 'shunt', amount: 0.8 }, ctx)
    script.push(text('Which sign does an inductor add in shunt?'))
    await answerNow('3 nH', 'sure')
    await idle()
    expect(app.profile.slips.at(-1)).toMatchObject({ confusion: 'reactance_sign' })
  })

  it('from a move: the part that takes one point to another; refuses a move one part can\'t make', async () => {
    const ok = await runTool('ask_component', { question: 'q', connection: 'series', from_point: { r: 1, x: 0.4 }, to_point: { r: 1, x: -0.2 } }, ctx)
    expect(ok.content).toMatch(/series C/)
    const bad = await runTool('ask_component', { question: 'q', connection: 'series', from_point: { r: 0.6, x: 0.4 }, to_point: { r: 1, x: 0 } }, ctx)
    expect(bad.isError).toBe(true)
    expect(bad.content).toMatch(/keeps r fixed/)
  })
})

describe('adaptive sign-off: the tutor logs the reason and transfer; the app decides', () => {
  const lesson = (id: string, turn = 1) => ({ ...ctx, session: () => ({ id }), learnerTurns: () => turn, autoRecorded: () => false })
  const observe = (id: string, turn: number) =>
    runTool('record_evidence', { skill: 'reflection', outcome: 'correct', difficulty: 2, reason: 'right', transfer: true, topic: 'gamma_vswr' }, lesson(id, turn))

  it('record_evidence needs the reason and transfer, and keeps them as structured evidence', async () => {
    const missing = await runTool('record_evidence', { skill: 'reflection', outcome: 'correct', difficulty: 2 }, lesson('L1'))
    expect(missing.isError).toBe(true)
    expect(missing.content).toMatch(/Give "reason"/)
    const noTransfer = await runTool('record_evidence', { skill: 'reflection', outcome: 'correct', difficulty: 2, reason: 'right' }, lesson('L1'))
    expect(noTransfer.content).toMatch(/Give "transfer"/)
    const ok = await runTool('record_evidence', { skill: 'reflection', outcome: 'correct', difficulty: 2, reason: 'right', transfer: true, topic: 'gamma_vswr', note: 'explained why' }, lesson('L1'))
    expect(ok.isError).toBe(false)
    expect(app.profile.observations.at(-1)).toMatchObject({ session: 'L1', skill: 'reflection', topic: 'gamma_vswr', outcome: 'correct', reason: 'right', transfer: true })
  })

  it('its observations clear a misconception only in later lessons, and it hears where it stands in the app\'s words', async () => {
    await runTool('log_misconception', { skill: 'reflection', topic: 'gamma_vswr', description: 'Confuses Γ with VSWR' }, lesson('L1', 1))
    // Same lesson: right, with the reason, in a new situation, and still it doesn't count.
    expect((await observe('L1', 2)).content).toMatch(/doesn't count toward clearing it \(same lesson it appeared in\)/)
    // A later lesson: the tutor's judgement counts half (0.5), the right reason and transfer ¼ each.
    expect((await observe('L2', 1)).content).toMatch(/looking better \(evidence 1 of 2\)/)
    expect(app.profile.misconceptions[0].resolved).toBe(false)
    expect((await observe('L3', 1)).content).toMatch(/cleared, provisionally.*don't call it fixed/)
    expect(app.profile.misconceptions[0].resolved).toBe(true)
  })

  it('resolve_misconception only removes one recorded by mistake; it can\'t declare one fixed', async () => {
    await runTool('log_misconception', { skill: 'reflection', topic: 'gamma_vswr', description: 'Confuses Γ with VSWR' }, lesson('L1', 1))
    const id = app.profile.misconceptions[0].id
    const noWhy = await runTool('resolve_misconception', { id }, lesson('L1', 2))
    expect(noWhy.isError).toBe(true)
    expect(noWhy.content).toMatch(/If they have overcome it, don't remove it/)
    const r = await runTool('resolve_misconception', { id, why: 'I misread their answer' }, lesson('L1', 2))
    expect(r.isError).toBe(false)
    expect(app.profile.misconceptions).toHaveLength(0)
  })
})

describe('independence ladder: the tools work out each item\'s rung and hold the tutor to the learner\'s', () => {
  const AT = new Date().toISOString()
  const onRung = (skill: string, rung: number, extra = {}) => {
    app.profile = { ...app.profile, ladder: { ...(app.profile.ladder ?? {}), [skill]: { rung, streak: 0, misses: 0, tries: 0, source: 'answers', at: AT, ...extra } } }
  }
  const NAMED_TASK = { title: 'Onto r = 1', instructions: 'Add a shunt capacitor until the point lands on the r = 1 circle.', target: { circle: { family: 'r', value: 1 } } }
  const OPEN_TASK = { title: 'Onto r = 1', instructions: 'Use one part of your choice to land on the r = 1 circle.', target: { circle: { family: 'r', value: 1 } } }

  it('refuses a guided task two steps below their rung, and leaves the chart as it was', async () => {
    useStudio.getState().loadSnapshot({ ...DEFAULT_SNAPSHOT, load: { kind: 'fixed', R: 100, X: 0 } })
    onRung('lumped_moves', 5) // judge: guided is two steps below on this skill (1, 2, 5)
    useStudio.getState().addElement('seriesL', 1e-9)
    const r = await runTool('create_target_task', NAMED_TASK, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/Too easy for them: this item is rung 1 \(guided\), and they're lumped_moves at rung 5 \(judge\)/)
    expect(r.content).toMatch(/have them judge a worked solution \(ask_spot_error\)/)
    expect(useStudio.getState().exercise).toBeNull()
    expect(useStudio.getState().network.map((e) => e.kind)).toEqual(['seriesL']) // not cleared
  })

  it('a task that leaves the part to them is one choice: one step below judge, allowed', async () => {
    useStudio.getState().loadSnapshot({ ...DEFAULT_SNAPSHOT, load: { kind: 'fixed', R: 100, X: 0 } })
    onRung('lumped_moves', 5)
    const r = await runTool('create_target_task', OPEN_TASK, ctx)
    expect(r.isError).toBe(false)
    expect(r.content).toMatch(/Independence: rung 2 \(one choice\); they're lumped_moves at rung 5 \(judge\): one step below, fine as a warm-up/)
    expect(useStudio.getState().exercise?.graded).toMatchObject({ skill: 'lumped_moves', rung: 2 })
  })

  it('a reason gets an easy item through, once a lesson, and the lesson keeps count', async () => {
    useStudio.getState().loadSnapshot({ ...DEFAULT_SNAPSHOT, load: { kind: 'fixed', R: 100, X: 0 } })
    onRung('lumped_moves', 5)
    let session: any = { id: 'L9', rungOverrides: [] }
    const inLesson = { ...ctx, session: () => session, updateSession: (fn: (s: any) => any) => { session = fn(session) } }
    const first = await runTool('create_target_task', { ...NAMED_TASK, rung_reason: 'warm_up' }, inLesson)
    expect(first.isError).toBe(false)
    expect(first.content).toMatch(/below their rung 5 \(warm up: 0 more like this allowed this lesson\)/)
    expect(session.rungOverrides).toMatchObject([{ reason: 'warm_up', skill: 'lumped_moves' }])
    const second = await runTool('create_target_task', { ...NAMED_TASK, rung_reason: 'warm_up' }, inLesson)
    expect(second.isError).toBe(true)
    expect(second.content).toMatch(/already used 1× this lesson/)
  })

  it('a clean pass on a stretch task moves them up, and the answer keeps its rung', async () => {
    useStudio.getState().loadSnapshot({ ...DEFAULT_SNAPSHOT, load: { kind: 'fixed', R: 30, X: 20 } })
    onRung('lumped_moves', 1, { provisional: true, source: 'start' })
    await runTool('create_target_task', { title: 'Onto g = 1', instructions: 'One series element.', target: { circle: { family: 'g', value: 1 } }, allowed_kinds: ['seriesL', 'seriesC'] }, ctx)
    expect(useStudio.getState().exercise?.graded?.rung).toBe(2)
    const sol = findReach(c(30, 20), parseTarget({ circle: { family: 'g', value: 1 } }), ['seriesL', 'seriesC'], 1, F, 50).network[0]
    useStudio.getState().addElement(sol.kind, sol.value)
    script.push(text('Nice.'))
    expect((await checkExerciseAsync())?.passed).toBe(true)
    await idle()
    expect(app.profile.ladder.lumped_moves).toMatchObject({ rung: 2, provisional: false })
    expect(app.profile.answers.at(-1)).toMatchObject({ topic: 'reach_lumped', rung: 2, outcome: 'correct' })
    expect(lastUserText(requests[0])).toMatch(/independence ladder: lumped_moves passed a harder item cleanly: rung 1 \(guided\) → rung 2 \(one choice\)/)
  })

  it('questions get their rungs: a move with its reason is one choice, spot the mistake is judge, a part and its value is one choice', async () => {
    useStudio.getState().loadSnapshot({ ...DEFAULT_SNAPSHOT, load: { kind: 'fixed', R: 30, X: 20 } })
    await runTool('ask_move', { element: { kind: 'shuntC' }, from: 'load' }, ctx)
    expect(useStudio.getState().prediction?.graded).toMatchObject({ skill: 'lumped_moves', rung: 2 })
    await runTool('ask_move', { element: { kind: 'shuntC' }, from: 'load', with_reason: false }, ctx)
    expect(useStudio.getState().prediction?.graded?.rung).toBe(1)
    await runTool('ask_spot_error', { mistake: 'direction' }, ctx)
    expect(useStudio.getState().prediction?.graded?.rung).toBe(5)
    await runTool('ask_component', { question: 'Which part adds x = 1 in series?', connection: 'series', amount: 1 }, ctx)
    expect(useStudio.getState().prediction?.graded).toMatchObject({ skill: 'l_match', rung: 2 })
    // Reading questions have no rung.
    await runTool('ask_value', { question: 'VSWR?', quantity: 'vswr', from: 'load' }, ctx)
    expect(useStudio.getState().prediction?.graded?.rung).toBeUndefined()
    await runTool('ask_locate', { question: 'Click z = 1 + j1', point: { r: 1, x: 1 } }, ctx)
    expect(useStudio.getState().prediction?.graded?.rung).toBeUndefined()
    await runTool('ask_locate', { question: 'Where does 2 pF of shunt C take the load?', element: { kind: 'shuntC', value: 2e-12 }, from: 'load' }, ctx)
    expect(useStudio.getState().prediction?.graded?.rung).toBe(1)
  })

  it('a full match: naming the parts makes it one choice (help, not a "tight" constraint); a band makes it constrained', async () => {
    useStudio.getState().loadSnapshot({ ...DEFAULT_SNAPSHOT, load: { kind: 'fixed', R: 100, X: 0 } })
    const named = await runTool('create_exercise', { title: 'Match it', instructions: 'Build it with a shunt C, then a series L.', freq_hz: F, max_vswr: 1.5, allowed_kinds: ['shuntC', 'seriesL'] }, ctx)
    expect(named.content).not.toMatch(/^Error/)
    expect(useStudio.getState().exercise?.graded).toMatchObject({ topic: 'l_match', difficulty: 2, rung: 2 })
    const open = await runTool('create_exercise', { title: 'Match it', instructions: 'Match this load to VSWR ≤ 1.5.', freq_hz: F, max_vswr: 1.5 }, ctx)
    expect(open.isError).toBe(false)
    expect(useStudio.getState().exercise?.graded).toMatchObject({ topic: 'l_match', rung: 3 })
    const band = await runTool('create_exercise', { title: 'Across the band', instructions: 'Keep VSWR ≤ 1.5 from 2.3 to 2.5 GHz.', freq_hz: F, max_vswr: 1.5, band_low_hz: 2.3e9, band_high_hz: 2.5e9 }, ctx)
    expect(band.isError).toBe(false)
    expect(useStudio.getState().exercise?.graded).toMatchObject({ topic: 'band_match', skill: 'q_bandwidth', rung: 4 })
  })

  it('a full match refused for being too easy leaves the chart and load untouched', async () => {
    useStudio.getState().loadSnapshot({ ...DEFAULT_SNAPSHOT, load: { kind: 'fixed', R: 100, X: 0 } })
    onRung('l_match', 4)
    const r = await runTool('create_exercise', { title: 'Match it', instructions: 'Build it with a shunt C, then a series L.', freq_hz: F, max_vswr: 1.5, scenario: { load: { kind: 'fixed', R: 25, X: 25 } } }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/Too easy for them: this item is rung 2 \(one choice\), and they're l_match at rung 4 \(constrained\)/)
    expect(useStudio.getState().exercise).toBeNull()
    expect(useStudio.getState().load).toMatchObject({ kind: 'fixed', R: 100, X: 0 })
  })
})
