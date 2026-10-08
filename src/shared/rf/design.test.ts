import { describe, expect, it } from 'vitest'
import { c } from './complex'
import { metricsFromZ } from './metrics'
import { inputImpedance } from './network'
import { solveSingleStub, stubNetwork } from './solvers'
import { evaluateDesign, matchCandidates } from './design'

const F = 2.4e9

describe('single-stub match', () => {
  it.each([[c(25, -40)], [c(100, 50)], [c(10, 0)], [c(200, -150)]])('every solution matches %o', (ZL) => {
    const sols = solveSingleStub(ZL, 50)
    expect(sols.length).toBeGreaterThanOrEqual(4) // two crossings × open/short
    for (const s of sols) {
      expect(s.lineDeg).toBeGreaterThanOrEqual(0)
      expect(s.lineDeg).toBeLessThan(180)
      expect(s.stubDeg).toBeGreaterThan(0)
      expect(s.stubDeg).toBeLessThan(180)
      expect(metricsFromZ(inputImpedance(ZL, stubNetwork(s, 50, F), F), 50).vswr).toBeLessThan(1.001)
    }
  })

  it('a load already on the g = 1 circle needs no line', () => {
    // y = 1 − j0.5 → z = 1/(1 − j0.5)
    const d = 1 + 0.25
    const onCircle = solveSingleStub(c((1 / d) * 50, (0.5 / d) * 50), 50)
    expect(onCircle[0].lineDeg).toBeCloseTo(0, 6)
    expect(stubNetwork(onCircle[0], 50, F)).toHaveLength(1)
  })

  it('a short or open load gives nothing', () => {
    expect(solveSingleStub(c(0, 20), 50)).toEqual([])
  })
})

describe('evaluating a design', () => {
  const load = { kind: 'fixed' as const, R: 25, X: -40 }

  it('candidates include the L-networks and two stub matches, all matched at f0', () => {
    const cands = matchCandidates(c(25, -40), 50, F)
    expect(cands.filter((x) => x.family === 'L').length).toBeGreaterThanOrEqual(2)
    expect(cands.filter((x) => x.family === 'stub')).toHaveLength(2)
    for (const x of cands) expect(evaluateDesign(load, [], x.elements, { z0: 50, f0: F }).vswr).toBeLessThan(1.001)
  })

  it('reports the band: worst VSWR, whether it meets the target, and the matched bandwidth around f0', () => {
    const net = matchCandidates(c(25, -40), 50, F)[0].elements
    const r = evaluateDesign(load, [], net, { z0: 50, f0: F, band: { low: 2.3e9, high: 2.5e9 }, vswrMax: 2 })
    expect(r.band!.worstVswr).toBeGreaterThan(1)
    expect(r.band!.meets).toBe(r.band!.worstVswr <= 2)
    expect(r.bandwidth!.low).toBeLessThan(F)
    expect(r.bandwidth!.high).toBeGreaterThan(F)
  })

  it('an unmatched load has no bandwidth around f0', () => {
    expect(evaluateDesign({ kind: 'fixed', R: 5, X: 80 }, [], [], { z0: 50, f0: F }).bandwidth).toBeUndefined()
  })
})
