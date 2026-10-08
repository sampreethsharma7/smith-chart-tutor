import { describe, expect, it } from 'vitest'
import { c } from './complex'
import { describeMove } from './moves'
import type { ElementKind } from './network'

// The load from the learner's lesson: z = 0.6 + j0.4 on a 50 Ω chart, at 2.4 GHz.
const Z = c(30, 20)
const f = 2.4e9
const el = (kind: ElementKind, value: number) => ({ id: 'x', kind, value, zc: 50, refHz: f })

describe('describeMove (the facts the tutor must use)', () => {
  it('shunt C: clockwise along the g circle, upper → lower half, crossing on the side facing the centre', () => {
    const m = describeMove(Z, el('shuntC', 2e-12), f, 50)
    expect(m.rotation).toBe('clockwise')
    expect(m.follows).toMatch(/constant g = 1\.15/)
    expect(m.start.chart_half).toBe('upper')
    expect(m.end.chart_half).toBe('lower')
    expect(m.real_axis).toMatch(/side facing the chart centre/)
    expect(m.start.y).toBe('1.15 − j0.77')
    expect(m.end.meaning).toMatch(/as admittance: b > 0/)
  })

  it('series L: clockwise along r = 0.6, stays in the upper half', () => {
    const m = describeMove(Z, el('seriesL', 1e-9), f, 50)
    expect(m.rotation).toBe('clockwise')
    expect(m.follows).toMatch(/constant r = 0\.6/)
    expect(m.end.chart_half).toBe('upper')
    expect(m.real_axis).toBe('does not cross the real axis')
  })

  it('series C and shunt L turn counter-clockwise', () => {
    expect(describeMove(Z, el('seriesC', 2e-12), f, 50).rotation).toBe('counter-clockwise')
    expect(describeMove(Z, el('shuntL', 5e-9), f, 50).rotation).toBe('counter-clockwise')
  })

  it('a line moves toward the generator: clockwise around the centre', () => {
    const m = describeMove(Z, el('tline', 45), f, 50)
    expect(m.rotation).toBe('clockwise')
    expect(m.turned_deg).toBe(90) // λ/8 = 45° of line = 90° on the chart
    expect(m.follows).toMatch(/around the chart centre/)
  })
})
