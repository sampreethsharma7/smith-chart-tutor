import { beforeEach, describe, expect, it } from 'vitest'
import { useStudio, DEFAULT_SNAPSHOT } from '@/state/studio'
import { computeDerived } from '@/state/derived'
import { FULL_VIEW, inView } from '@/chart/ChartBase'
import { runTool } from '../registry'
import type { ToolContext } from '../types'

const ctx = {
  get studio() { return useStudio.getState() },
  derived: () => computeDerived(useStudio.getState().snapshot())
} as unknown as ToolContext

describe('what_if move facts', () => {
  beforeEach(() => useStudio.getState().loadSnapshot(DEFAULT_SNAPSHOT))

  it('returns the verified move for the learner\'s shunt C question', async () => {
    useStudio.getState().setLoad({ kind: 'fixed', R: 30, X: 20 })
    const r = await runTool('what_if', { elements: [{ kind: 'shuntC', value: 2e-12 }] }, ctx)
    expect(r.isError).toBe(false)
    const move = JSON.parse(r.content).steps[1].move
    expect(move.rotation).toBe('clockwise')
    expect(move.start.chart_half).toBe('upper')
    expect(move.end.chart_half).toBe('lower')
  })

  it('accepts the malformed call a weaker model actually made', async () => {
    // From a real run: one "element" as a bare string, a made-up start field, no value.
    const r = await runTool('what_if', { freq_hz: 2.4e9, start_point: { g: 0.5, b: -1, type: 'admittance' }, element: 'shuntL' }, ctx)
    expect(r.isError).toBe(false)
    const out = JSON.parse(r.content)
    expect(out.steps[1].move.rotation).toBe('counter-clockwise')
    expect(out.notes[0]).toMatch(/No value given/)
    // Another real one: the element's kind at the top level.
    const r2 = await runTool('what_if', { kind: 'shuntL', steps: 10, start_point: { kind: 'impedance', r: 5, x: 10 } }, ctx)
    expect(r2.isError).toBe(false)
    // And another: invented names. The kind is understood; the unknown start is not guessed, and the result says so.
    const r3 = await runTool('what_if', { element_kind: 'shuntL', start_chart_half: 'impedance', start_z: { r: 50, x: 20 } }, ctx)
    expect(r3.isError).toBe(false)
    expect(JSON.parse(r3.content).notes.join(' ')).toMatch(/Ignored start_z.*Started from the current load/)
  })
})

describe('tutor zoom (focus_chart)', () => {
  beforeEach(() => {
    useStudio.getState().loadSnapshot(DEFAULT_SNAPSHOT)
    useStudio.setState({ learnerViewAt: 0 })
  })

  it('frames what it talks about, and the learner can go back to their own view', async () => {
    const before = { cx: -0.5, cy: 0.1, half: 0.6 }
    useStudio.getState().setView(before, 'learner')
    useStudio.setState({ learnerViewAt: 0 }) // as if they zoomed a while ago
    const r = await runTool('focus_chart', { targets: ['load', 'markers'], reason: 'the two markers' }, ctx)
    expect(r.isError).toBe(false)
    const s = useStudio.getState()
    expect(s.tutorView?.reason).toBe('the two markers')
    expect(s.view.half).toBeLessThan(FULL_VIEW.half)
    const d = computeDerived(s.snapshot())
    for (const m of d.markers) expect(inView(s.view, m.load.gamma)).toBe(true)
    s.restoreView()
    expect(useStudio.getState().view).toEqual(before)
    expect(useStudio.getState().tutorView).toBeNull()
    expect(useStudio.getState().events.at(-1)?.text).toMatch(/Went back to their own view/)
  })

  it('drops its zoom when it sets up a new scenario', async () => {
    await runTool('focus_chart', { targets: ['load'], reason: 'the load' }, ctx)
    expect(useStudio.getState().tutorView).not.toBeNull()
    await runTool('set_scenario', { load: { type: 'fixed', r_ohm: 20, x_ohm: -30 } }, ctx)
    expect(useStudio.getState().tutorView).toBeNull()
    expect(useStudio.getState().view).toEqual(FULL_VIEW)
  })

  it('leaves the view alone while the learner is moving it', async () => {
    useStudio.getState().setView({ cx: 0, cy: 0, half: 0.5 }, 'learner')
    const r = await runTool('focus_chart', { targets: ['load'] }, ctx)
    expect(r.isError).toBe(true)
    expect(useStudio.getState().tutorView).toBeNull()
  })

  it('logs the learner\'s zooming so the tutor knows what they see', () => {
    useStudio.getState().setView({ cx: 0.1, cy: -0.1, half: 0.31 }, 'learner')
    expect(useStudio.getState().events.at(-1)?.text).toMatch(/4\.0× zoom around z ≈/)
  })
})

describe('one frequency unless the lesson needs a band', () => {
  beforeEach(() => useStudio.getState().loadSnapshot(DEFAULT_SNAPSHOT))

  it('a fixed-load setup shows one point: no band, and no markers left over from the antenna', async () => {
    // The real Problem 1 call: a fixed load with a sweep the model filled in, no markers.
    const r = await runTool('create_exercise', {
      title: 'Problem 1', instructions: 'Match it', freq_hz: 2.4e9, max_vswr: 1.2, max_elements: 2,
      allowed_kinds: ['seriesL', 'seriesC', 'shuntL', 'shuntC'],
      scenario: { z0: 50, load: { kind: 'fixed', R: 30, X: 20 }, sweep: { start_hz: 2e9, stop_hz: 2.8e9, points: 101 }, design_freq_hz: 2.4e9 }
    }, ctx)
    expect(r.isError).toBe(false)
    const s = useStudio.getState()
    expect(s.showBand).toBe(false)
    expect(s.markers).toEqual([])
    const state = JSON.parse((await runTool('get_chart_state', {}, ctx)).content)
    expect(state.frequency_band).toMatch(/^hidden/)
    expect(state.markers).toBeUndefined()
  })

  it('a load that changes with frequency shows the band, centred on the design frequency', async () => {
    await runTool('set_scenario', { load: { kind: 'antenna', topology: 'series', f0_hz: 5.8e9, R: 40, Q: 6 }, design_freq_hz: 5.8e9 }, ctx)
    const s = useStudio.getState()
    expect(s.showBand).toBe(true)
    expect(s.markers).toEqual([])
    expect(s.sweep.start).toBeLessThan(5.8e9)
    expect(s.sweep.stop).toBeGreaterThan(5.8e9)
  })

  it('the tutor can turn the band on for a bandwidth lesson, and a tweak keeps the setup', async () => {
    await runTool('set_scenario', { load: { kind: 'fixed', R: 30, X: 20 } }, ctx)
    await runTool('set_scenario', { show_band: true, band_reason: 'how wide the match is', markers_hz: [2.3e9, 2.5e9] }, ctx)
    let s = useStudio.getState()
    expect(s.showBand).toBe(true)
    expect(s.events.at(-1)?.text).toMatch(/Tutor showed the frequency band.*: how wide the match is/)
    await runTool('set_scenario', { overlays: { admittance: true } }, ctx)
    s = useStudio.getState()
    expect(s.markers).toEqual([2.3e9, 2.5e9])
    expect(s.load).toEqual({ kind: 'fixed', R: 30, X: 20 })
  })

  it('an exercise graded across a band shows it, with its edges marked', async () => {
    const r = await runTool('create_exercise', {
      title: 'Wide', instructions: 'Match across the band', freq_hz: 2.4e9, max_vswr: 2, band_low_hz: 2.3e9, band_high_hz: 2.5e9,
      scenario: { load: { kind: 'fixed', R: 30, X: 20 } }
    }, ctx)
    expect(r.isError).toBe(false)
    expect(useStudio.getState().showBand).toBe(true)
    expect(useStudio.getState().markers).toEqual([2.3e9, 2.5e9])
  })

  it('the learner\'s own toggle is logged for the tutor', () => {
    useStudio.getState().setShowBand(false, 'learner')
    expect(useStudio.getState().events.at(-1)?.text).toMatch(/Learner hid the frequency band/)
  })

  it('a chart saved before this with a fixed load opens at one frequency', () => {
    const { showBand: _, ...old } = { ...DEFAULT_SNAPSHOT, load: { kind: 'fixed' as const, R: 30, X: 20 } }
    useStudio.getState().loadSnapshot(old)
    expect(useStudio.getState().showBand).toBe(false)
    useStudio.getState().loadSnapshot({ ...old, load: DEFAULT_SNAPSHOT.load })
    expect(useStudio.getState().showBand).toBe(true)
  })
})

describe('annotate_chart says only what it really drew', () => {
  beforeEach(() => useStudio.getState().loadSnapshot(DEFAULT_SNAPSHOT))

  it('a VSWR circle given only a point is drawn through that point (a real Gemini call drew nothing and said it had)', async () => {
    const r = await runTool('annotate_chart', { shapes: [{ kind: 'vswrCircle', color: '#3b82f6', at: { r: 0.6, x: 0 } }] }, ctx)
    expect(r.isError).toBe(false)
    expect(r.content).toMatch(/VSWR 1\.67 circle \(through the point given\)/)
    expect(useStudio.getState().annotations[0].value).toBeCloseTo(1 / 0.6, 6)
  })

  it('a shape that cannot be drawn is reported, and nothing drawable means an error, not "Drew 1 shape"', async () => {
    const some = await runTool('annotate_chart', { shapes: [{ kind: 'rCircle', value: 1 }, { kind: 'vswrCircle' }, { kind: 'point' }] }, ctx)
    expect(some.content).toMatch(/^Drew a constant-r circle r = 1\. NOT drawn/)
    const none = await runTool('annotate_chart', { shapes: [{ kind: 'vswrCircle' }] }, ctx)
    expect(none.isError).toBe(true)
    expect(none.content).toMatch(/Nothing was drawn/)
  })
})

describe('nothing the lesson points at is silently hidden (flagged: "there is no trace here that I can see")', () => {
  beforeEach(() => useStudio.getState().loadSnapshot({ ...DEFAULT_SNAPSHOT, showBand: false, overlays: { ...DEFAULT_SNAPSHOT.overlays, showLoadTrace: false, showInputTrace: false, showPath: false } }))

  it('turning the band on brings its trace with it', async () => {
    await runTool('set_scenario', { show_band: true, band_reason: 'see the sweep' }, ctx)
    expect(useStudio.getState().overlays.showLoadTrace).toBe(true)
  })

  it('the tutor is told what the learner can not see, and can switch it on', async () => {
    useStudio.getState().setShowBand(true, 'learner')
    useStudio.getState().set('network', [{ id: 'a', kind: 'seriesL', value: 1e-9 }])
    const state = JSON.parse((await runTool('get_chart_state', {}, ctx)).content)
    expect(state.hidden_from_learner).toMatch(/the load trace.*the input trace.*the matching path/)
    await runTool('set_scenario', { overlays: { load_trace: true, input_trace: true, matching_path: true } }, ctx)
    const o = useStudio.getState().overlays
    expect([o.showLoadTrace, o.showInputTrace, o.showPath]).toEqual([true, true, true])
    expect(JSON.parse((await runTool('get_chart_state', {}, ctx)).content).hidden_from_learner).toBeUndefined()
  })

  it('adding an element shows the matching path (flagged: "added a Line, no curve")', () => {
    useStudio.getState().addElement('tline', 45)
    expect(useStudio.getState().overlays.showPath).toBe(true)
    expect(useStudio.getState().events.at(-1)!.text).toMatch(/matching path came on/)
  })
})
