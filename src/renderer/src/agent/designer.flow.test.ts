import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatRequest, Part } from '@shared/llm'
import { metricsFromZ } from '@shared/rf/metrics'
import { inputImpedance, loadImpedance } from '@shared/rf/network'
import { matchCandidates } from '@shared/rf/design'
import { c } from '@shared/rf/complex'

// ── A scripted model and an in-memory app, so the real design loop runs end to end ──
const script: Part[][] = []
const requests: ChatRequest[] = []
const app = vi.hoisted(() => ({ profile: null as any, mode: 'design' as 'design' | 'lesson' }))

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
    currentChartMode: () => app.mode,
    registerBusy: () => {},
    api: () => ({
      llm: {
        chat: (req: ChatRequest) => {
          requests.push(JSON.parse(JSON.stringify(req)))
          const message: ChatMessage = { role: 'assistant', parts: script.shift() ?? [{ type: 'text', text: 'OK.' }] }
          return { requestId: `r${requests.length}`, done: Promise.resolve({ type: 'done', result: { message, stopReason: 'end', usage: {}, timing: { ttftMs: 1, totalMs: 1 } } }) }
        },
        abort: () => {}
      },
      conversation: { save: async () => {}, get: async () => null },
      design: { save: async () => {}, get: async () => null }
    })
  }
})
vi.stubGlobal('window', { addEventListener: () => {} })

const { useStudio, DEFAULT_SNAPSHOT } = await import('@/state/studio')
const { useDesigner } = await import('./designer')
const { buildDesignPrompt } = await import('./design/prompt')
const { designOpening } = await import('./tutor')

const F = 2.4e9
// A real match for the test load (25 − j40 Ω at 2.4 GHz)
const GOOD = matchCandidates(c(25, -40), 50, F)[0].elements.map(({ kind, value }) => ({ kind, value }))
const call = (name: string, args: Record<string, unknown>): Part => ({ type: 'tool_call', id: `c_${name}_${Math.random()}`, name, args })
const say = (t: string): Part => ({ type: 'text', text: t })
const vswr = (net = useStudio.getState().network) => {
  const s = useStudio.getState()
  return metricsFromZ(inputImpedance(loadImpedance(s.load, F, s.datasets), net, F), s.z0).vswr
}

beforeEach(async () => {
  const { createProfile } = await import('@shared/profile')
  app.profile = createProfile('Sam')
  app.mode = 'design'
  script.length = 0
  requests.length = 0
  useDesigner.getState().clear()
  useStudio.getState().loadSnapshot({ ...DEFAULT_SNAPSHOT, load: { kind: 'fixed', R: 25, X: -40 }, designFreq: F, showBand: false })
})

describe('the design assistant', () => {
  it('offers its own tools and the chart tools, none of the teaching or grading ones', async () => {
    script.push([say('Hi.')])
    await useDesigner.getState().send('hello')
    const names = requests[0].tools!.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['get_chart_state', 'what_if', 'match_options', 'check_network', 'propose_designs', 'apply_design']))
    for (const t of ['ask_move', 'create_exercise', 'record_evidence', 'log_misconception', 'set_lesson_goal', 'solve_l_match', 'edit_network']) expect(names).not.toContain(t)
    expect(requests[0].tools!.map((t) => t.description).join(' ')).not.toMatch(/learner|lesson/i)
  })

  it('works out the options, shows them as cards with the app\'s own numbers, and changes nothing until applied', async () => {
    script.push([call('match_options', { vswr_max: 2 })])
    script.push([say('There are four ways to do this.')])
    await useDesigner.getState().send('Match my load at 2.4 GHz')
    const options = JSON.parse(requests[1].messages.at(-1)!.parts.find((p) => p.type === 'tool_result')!.content as string).options
    expect(options.some((o: any) => o.family === 'L')).toBe(true)
    expect(options.some((o: any) => o.family === 'stub')).toBe(true)
    // The model shows the first L-match and the first stub match.
    script.push([call('propose_designs', { recommended: 1, options: [options.find((o: any) => o.family === 'L'), options.find((o: any) => o.family === 'stub')].map((o: any) => ({ title: o.id, elements: o.elements, note: 'why' })) })])
    script.push([say('Option 1 is my pick.')])
    await useDesigner.getState().send('show me')
    const p = useDesigner.getState().proposal!
    expect(p.options).toHaveLength(2)
    expect(p.options[0].recommended).toBe(true)
    for (const o of p.options) expect(o.result.vswr).toBeLessThan(1.01)
    expect(useStudio.getState().network).toEqual([]) // nothing applied yet
    // Nothing went into the learning record.
    expect(app.profile.sessions).toEqual([])
    expect(app.profile.answers ?? []).toEqual([])
  })

  it('Apply puts the design on the chart, Undo takes it back; never onto the lesson chart', async () => {
    script.push([call('propose_designs', { options: [{ title: 'Shunt C, series L', elements: GOOD }] })])
    script.push([say('One option.')])
    await useDesigner.getState().send('go')
    const before = useStudio.getState().network
    expect(useDesigner.getState().apply(1)).toMatch(/Applied option 1/)
    expect(useStudio.getState().network.map((e) => e.kind)).toEqual(GOOD.map((e) => e.kind))
    expect(useDesigner.getState().proposal!.applied).toBe(0)
    useDesigner.getState().undoApply()
    expect(useStudio.getState().network).toEqual(before)
    app.mode = 'lesson'
    expect(() => useDesigner.getState().apply(1)).toThrow(/Design chart is not open/)
  })

  it('can set up the view of the chart but never replace the user\'s load (a weak model tried, live)', async () => {
    const before = useStudio.getState().load
    script.push([call('set_scenario', { load: { kind: 'antenna', topology: 'parallel', f0_hz: 2.45e9, R: 50, Q: 10 }, clear_network: true, show_band: true })])
    script.push([say('Done.')])
    await useDesigner.getState().send('show me the band')
    expect(useStudio.getState().load).toEqual(before)
    expect(useStudio.getState().showBand).toBe(true)
    const spec = requests[0].tools!.find((t) => t.name === 'set_scenario')!
    expect(Object.keys(spec.parameters.properties ?? {})).not.toContain('load')
    // Results read as to a colleague, not a learner.
    expect(requests[1].messages.at(-1)!.parts.find((p) => p.type === 'tool_result')!.content).not.toMatch(/learner/i)
  })

  it('applying a design made for a band shows that band on the chart', async () => {
    useStudio.getState().set('markers', [])
    script.push([call('propose_designs', { band: { low_hz: 2.3e9, high_hz: 2.5e9 }, options: [{ title: 'A', elements: GOOD }] })])
    script.push([say('One option.')])
    await useDesigner.getState().send('go')
    useDesigner.getState().apply(1)
    const s = useStudio.getState()
    expect(s.showBand).toBe(true)
    expect(s.markers).toEqual([2.3e9, 2.5e9])
    expect(s.sweep.start).toBeLessThanOrEqual(2.3e9)
    expect(s.sweep.stop).toBeGreaterThanOrEqual(2.5e9)
  })

  it('check_network reports the band and whether it meets the target', async () => {
    script.push([call('check_network', { elements: [{ kind: 'seriesL', value: 1e-9 }], band: { low_hz: 2.3e9, high_hz: 2.5e9 }, vswr_max: 2 })])
    script.push([say('Done.')])
    await useDesigner.getState().send('check')
    const r = JSON.parse(requests[1].messages.at(-1)!.parts.find((p) => p.type === 'tool_result')!.content as string)
    expect(r.band.meets_target).toBe(false)
    expect(r.at_f0.vswr).toBeCloseTo(vswr([{ id: 'x', kind: 'seriesL', value: 1e-9 }]), 3)
  })

  it('explains as much as the person needs, from their profile', () => {
    app.profile = { ...app.profile, background: { ...app.profile.background, experience: 'advanced' } }
    expect(buildDesignPrompt(app.profile).dynamic).toMatch(/Terse/)
    app.profile = { ...app.profile, background: { ...app.profile.background, experience: 'new' } }
    expect(buildDesignPrompt(app.profile).dynamic).toMatch(/plain words/)
    expect(buildDesignPrompt(app.profile).stable).toMatch(/not a lesson/)
  })

  it('"Teach me why" opens a lesson that starts from the design', () => {
    const t = designOpening(3, 'load 25 − j40 Ω, network Shunt C 1.8 pF → Series L 2 nH')
    expect(t).toMatch(/^\[Lesson 3 start\]/)
    expect(t).toMatch(/Shunt C 1\.8 pF → Series L 2 nH/)
    expect(t).toMatch(/set_lesson_goal/)
  })
})

describe('"apply option 2" is done by the app', () => {
  it('reads plain requests to apply, and nothing else', async () => {
    const { applyRequest } = await import('./designer')
    expect(applyRequest('ok, apply option 1', 3)).toBe(1)
    expect(applyRequest('Use design 2 please', 3)).toBe(2)
    expect(applyRequest('go with #3', 3)).toBe(3)
    expect(applyRequest('apply 2', 1)).toBe(0) // there's no option 2
    expect(applyRequest("don't apply option 1", 3)).toBe(0)
    expect(applyRequest('why would I use option 2?', 3)).toBe(0)
    expect(applyRequest('use 50 ohm', 3)).toBe(0)
    expect(applyRequest('apply option 1', 0)).toBe(0)
  })

  it('applies it before the model replies, so a model that only says it did can\'t fool anyone', async () => {
    script.push([call('propose_designs', { options: [{ title: 'A', elements: GOOD }] })])
    script.push([say('One option.')])
    await useDesigner.getState().send('go')
    script.push([say('Applied!')])
    await useDesigner.getState().send('ok, apply option 1')
    expect(useStudio.getState().network.map((e) => e.kind)).toEqual(GOOD.map((e) => e.kind))
    expect(JSON.stringify(requests.at(-1)!.messages.at(-1))).toMatch(/The app applied option 1/)
  })

  it('options that are not matched at the design frequency (wrong units) never become cards', async () => {
    script.push([call('propose_designs', { options: [{ title: 'Bad units', elements: [{ kind: 'shuntC', value: 1.8 }, { kind: 'seriesL', value: 2 }] }, { title: 'Good', elements: GOOD }] })])
    script.push([call('propose_designs', { options: [{ title: 'Again', elements: GOOD }] })])
    script.push([say('Done.')])
    await useDesigner.getState().send('go')
    expect(useDesigner.getState().proposal!.options.map((o) => o.title)).toEqual(['Good'])
    const results = requests.flatMap((r) => r.messages.at(-1)!.parts).filter((p) => p.type === 'tool_result').map((p) => (p as any).content)
    expect(results.join(' ')).toMatch(/Not matched at .*Bad units/)
    expect(results.join(' ')).toMatch(/already on screen this turn/)
  })
})

describe('the band verdict', () => {
  it('says plainly when no option meets the band', async () => {
    script.push([call('propose_designs', { band: { low_hz: 1.5e9, high_hz: 3.5e9 }, vswr_max: 1.2, options: [{ title: 'A', elements: GOOD }] })])
    script.push([say('Done.')])
    await useDesigner.getState().send('go')
    expect(JSON.stringify(requests.at(-1)!.messages.at(-1))).toMatch(/NONE of these meets VSWR/)
  })
})
