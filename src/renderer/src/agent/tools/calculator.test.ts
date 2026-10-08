import { beforeEach, describe, expect, it } from 'vitest'
import { useStudio, DEFAULT_SNAPSHOT } from '@/state/studio'
import { computeDerived } from '@/state/derived'
import { convertLocked, runCalc, useCalc, DEFAULT_INPUTS, addComponent } from '@/state/calc'
import { inputImpedance } from '@shared/rf/network'
import { c } from '@shared/rf/complex'
import { runTool } from '../registry'
import type { ToolContext } from '../types'

const ctx = {
  get studio() { return useStudio.getState() },
  derived: () => computeDerived(useStudio.getState().snapshot())
} as unknown as ToolContext

const F = 2.4e9

beforeEach(() => {
  useStudio.getState().loadSnapshot({ ...DEFAULT_SNAPSHOT, load: { kind: 'fixed', R: 30, X: 20 }, designFreq: F })
  useCalc.getState().reset()
  useCalc.getState().setOpen(false)
})

describe('the calculator reads the chart and the learner\'s input', () => {
  it('reads amounts the way people type them', () => {
    for (const t of ['0.8', '+j0.8', 'j 0.8', '+0.8']) expect(runCalc({ ...DEFAULT_INPUTS, tab: 'component', amountText: t }).result!.component!.kind, t).toBe('seriesL')
    for (const t of ['-0.8', '−j0.8', '- j0.8']) expect(runCalc({ ...DEFAULT_INPUTS, tab: 'component', amountText: t }).result!.component!.kind, t).toBe('seriesC')
    expect(runCalc({ ...DEFAULT_INPUTS, tab: 'component', conn: 'shunt', normalised: false, amountText: '-8m' }).result!.component!.kind).toBe('shuntL')
    expect(runCalc({ ...DEFAULT_INPUTS, tab: 'component', amountText: 'lots' }).error).toMatch(/Can't read/)
    expect(runCalc({ ...DEFAULT_INPUTS, tab: 'convert', convertText: '' }).error).toMatch(/Type a value/)
  })

  it('from → to as y works the same as from → to as z', () => {
    const asZ = runCalc({ ...DEFAULT_INPUTS, tab: 'component', compMode: 'move', conn: 'shunt', fromText: '0.6 + j0.4', toText: '0.6 - j0.4', pointsAs: 'z' })
    // The same two points as admittances.
    const asY = runCalc({ ...DEFAULT_INPUTS, tab: 'component', compMode: 'move', conn: 'shunt', fromText: '1.1538 - j0.76923', toText: '1.1538 + j0.76923', pointsAs: 'y' })
    expect(asZ.result!.component!.kind).toBe('shuntC')
    expect(asY.result!.component!.value).toBeCloseTo(asZ.result!.component!.value, 15)
  })

  it('"Add to network" puts the learner\'s part on the chart, and it lands where the calculator said', () => {
    const r = runCalc({ ...DEFAULT_INPUTS, tab: 'component', amountText: '-0.4' })
    addComponent(r.result!.component!)
    const s = useStudio.getState()
    expect(s.network).toHaveLength(1)
    const zin = inputImpedance(c(30, 20), s.network, F)
    expect(zin.im / 50).toBeCloseTo(0, 9)
    expect(s.events.at(-1)!.text).toMatch(/from the calculator/)
  })

  it('the network tab follows the chart', () => {
    expect(runCalc({ ...DEFAULT_INPUTS, tab: 'network' }).error).toMatch(/Add elements/)
    useStudio.getState().addElement('seriesC', 8e-12)
    useStudio.getState().addElement('shuntL', 6e-9)
    const r = runCalc({ ...DEFAULT_INPUTS, tab: 'network' })
    expect(r.rows).toHaveLength(2)
    const zin = inputImpedance(c(30, 20), useStudio.getState().network, F)
    expect(r.rows![1].zAfter.re).toBeCloseTo(zin.re / 50, 9)
  })

  it('notes what the learner worked out for the tutor, and whether a task was open', () => {
    useCalc.getState().set({ tab: 'component', amountText: '0.8' }, 'learner')
    useCalc.getState().logUse()
    expect(useStudio.getState().events.at(-1)!.text).toMatch(/^Used the calculator: series part for x = 0\.8: .*series L = /)
    useStudio.getState().setExercise({ id: 'e', title: 't', instructions: 'i', freqHz: F, maxVswr: 1.5, attempts: 0, status: 'active', hints: [] })
    useCalc.getState().logUse()
    expect(useStudio.getState().events.at(-1)!.text).toMatch(/while working on the task/)
  })
})

describe('graded questions stay graded', () => {
  const valueQuestion = () => useStudio.getState().setPrediction({ id: 'q', question: 'VSWR of the load?', kind: 'text', key: { type: 'value', quantity: 'vswr', expected: 2, tolPct: 5, z0: 50 } })

  it('the converter pauses while a "read this value" question is open (and nothing is logged)', () => {
    expect(convertLocked()).toBe(false)
    valueQuestion()
    expect(convertLocked()).toBe(true)
    useCalc.getState().set({ tab: 'convert', convertText: '0.6 + j0.4' }, 'learner')
    const before = useStudio.getState().events.length
    useCalc.getState().logUse()
    expect(useStudio.getState().events.length).toBe(before)
    useStudio.getState().setPrediction(null)
    expect(convertLocked()).toBe(false)
  })

  it('the tutor can\'t fill the calculator in while a graded question is open', async () => {
    valueQuestion()
    const r = await runTool('show_calculation', { mode: 'convert', from: 'z', value: '0.6+j0.4', reason: 'x' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/give the answer away/)
    expect(useCalc.getState().open).toBe(false)
  })
})

describe('show_calculation: the tutor walks through a calculation', () => {
  it('opens the calculator filled in, marked as the tutor\'s, and tells the tutor what the learner sees', async () => {
    const r = await runTool('show_calculation', { mode: 'component', connection: 'shunt', amount: 0.5, reason: 'how b becomes picofarads' }, ctx)
    expect(r.isError).toBe(false)
    expect(r.content).toMatch(/shunt C = .*pF/)
    expect(r.content).toMatch(/Don't repeat the numbers/)
    const st = useCalc.getState()
    expect(st.open).toBe(true)
    expect(st.tab).toBe('component')
    expect(st.tutorNote).toBe('how b becomes picofarads')
    // The learner's own edit takes it back.
    st.set({ amountText: '0.6' }, 'learner')
    expect(useCalc.getState().tutorNote).toBeNull()
  })

  it('handles every mode, and refuses bad input with a reason', async () => {
    expect((await runTool('show_calculation', { mode: 'convert', from: 'gamma', value: '0.34∠121', reason: 'r' }, ctx)).content).toMatch(/VSWR/)
    expect((await runTool('show_calculation', { mode: 'component_move', connection: 'series', from_point: '1 + j0.4', to_point: '1 - j0.2', reason: 'r' }, ctx)).content).toMatch(/series C/)
    const off = await runTool('show_calculation', { mode: 'component_move', connection: 'series', from_point: '0.6 + j0.4', to_point: '1', reason: 'r' }, ctx)
    expect(off.content).toMatch(/warns them: A series part keeps r fixed/)
    expect((await runTool('show_calculation', { mode: 'network', reason: 'r' }, ctx)).content).toMatch(/network is empty/)
    expect((await runTool('show_calculation', { mode: 'convert', value: 'abc', reason: 'r' }, ctx)).content).toMatch(/can't use that/)
    expect((await runTool('show_calculation', { mode: 'component', reason: 'r' }, ctx)).content).toMatch(/Give "amount"/)
  })

  it('warns the tutor when a worked example during a task might be the answer', async () => {
    useStudio.getState().setExercise({ id: 'e', title: 't', instructions: 'i', freqHz: F, maxVswr: 1.5, attempts: 0, status: 'active', hints: [] })
    const r = await runTool('show_calculation', { mode: 'component', amount: -0.4, reason: 'r' }, ctx)
    expect(r.content).toMatch(/given it away/)
  })
})
