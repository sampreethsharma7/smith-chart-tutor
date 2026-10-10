import { describe, expect, it } from 'vitest'
import { c } from './complex'
import { gammaFromZ, metricsFromZ } from './metrics'
import { applyElement, inputImpedance } from './network'
import {
  admittanceOf, describeTarget, expectedValue, findReach, gradeQuestion, meetsTarget, moveQuestion, parseComplex,
  parseNumber, parseTarget, targetError, type QuestionKey
} from './tasks'

const F = 2.4e9
const Z0 = 50
const LOAD = c(30, 20) // z = 0.6 + j0.4, y = 1.15 − j0.77
const W = 2 * Math.PI * F

describe('targets', () => {
  it('measures distance to each kind of circle in its own units', () => {
    const z = c(0.6, 0.4)
    expect(targetError(z, { type: 'circle', family: 'r', value: 1, tol: 0.05 })).toBeCloseTo(0.4)
    expect(targetError(z, { type: 'circle', family: 'x', value: 0, tol: 0.05 })).toBeCloseTo(0.4)
    expect(targetError(z, { type: 'circle', family: 'g', value: 1, tol: 0.05 })).toBeCloseTo(0.1538, 3)
    expect(targetError(z, { type: 'circle', family: 'b', value: -0.77, tol: 0.05 })).toBeLessThan(0.01)
    expect(targetError(z, { type: 'circle', family: 'vswr', value: 2.04, tol: 0.05 })).toBeLessThan(0.01)
    expect(targetError(c(1, 0), { type: 'point', z: c(1, 0), tol: 0.05, as: 'z' })).toBe(0)
    expect(meetsTarget(c(1.02, 0.01), { type: 'point', z: c(1, 0), tol: 0.05, as: 'z' })).toBe(true)
    expect(meetsTarget(z, { type: 'circle', family: 'g', value: 1, tol: 0.05 })).toBe(false)
  })

  it('parses tool arguments, with sensible tolerances, and rejects nonsense with a usable message', () => {
    expect(parseTarget({ circle: { family: 'g', value: 1 } })).toEqual({ type: 'circle', family: 'g', value: 1, tol: 0.05 })
    expect(parseTarget({ circle: { family: 'r', value: 3 } }).tol).toBeCloseTo(0.15)
    expect(parseTarget({ circle: { family: 'vswr', value: 2 } }).tol).toBeCloseTo(0.06)
    const y = parseTarget({ point: { g: 1, b: 0.5 } })
    expect(y.type === 'point' && y.as).toBe('y')
    expect(describeTarget(y)).toBe('the point y = 1 + j0.5')
    expect(describeTarget(parseTarget({ circle: { family: 'x', value: 0 } }))).toBe('the real axis')
    expect(parseTarget({ point: { r: 1, x: 0 }, tolerance: 0.1 }).tol).toBe(0.1)
    expect(() => parseTarget({ circle: { family: 'q', value: 1 } })).toThrow(/family/)
    expect(() => parseTarget({ circle: { family: 'vswr', value: 1 } })).toThrow(/VSWR > 1/)
    expect(() => parseTarget({ point: { r: -1, x: 0 } })).toThrow(/inside the chart/)
    expect(() => parseTarget(undefined)).toThrow(/Give "target"/)
  })
})

describe('reachability (so the tutor never sets an impossible task)', () => {
  const g1 = parseTarget({ circle: { family: 'g', value: 1 } })
  const r1 = parseTarget({ circle: { family: 'r', value: 1 } })
  const centre = parseTarget({ point: { r: 1, x: 0 } })

  it('one series element reaches the g = 1 circle from 30 + j20 Ω; a shunt one cannot (g stays 1.15)', () => {
    const series = findReach(LOAD, g1, ['seriesL', 'seriesC'], 1, F, Z0)
    expect(series.ok).toBe(true)
    // Check the found network independently: it really lands on g = 1.
    const z = inputImpedance(LOAD, series.network, F)
    expect(admittanceOf(c(z.re / Z0, z.im / Z0)).re).toBeCloseTo(1, 1)
    expect(findReach(LOAD, g1, ['shuntL', 'shuntC'], 1, F, Z0).ok).toBe(false)
  })

  it('the r = 1 circle needs two elements here (g = 1.15 never meets it)', () => {
    expect(findReach(LOAD, r1, ['seriesL', 'seriesC', 'shuntL', 'shuntC'], 1, F, Z0).ok).toBe(false)
    expect(findReach(LOAD, r1, ['seriesL', 'seriesC', 'shuntL', 'shuntC'], 2, F, Z0).ok).toBe(true)
  })

  it('the centre takes an L-match: two elements yes, one no', () => {
    const two = findReach(LOAD, centre, ['seriesL', 'seriesC', 'shuntL', 'shuntC'], 2, F, Z0)
    expect(two.ok).toBe(true)
    expect(two.network).toHaveLength(2)
    const z = inputImpedance(LOAD, two.network, F)
    expect(metricsFromZ(z, Z0).vswr).toBeLessThan(1.11)
    expect(findReach(LOAD, centre, ['seriesL', 'seriesC', 'shuntL', 'shuntC'], 1, F, Z0).ok).toBe(false)
  })

  it('a line reaches the real axis (it turns around the centre)', () => {
    const r = findReach(LOAD, parseTarget({ circle: { family: 'x', value: 0 } }), ['tline'], 1, F, Z0)
    expect(r.ok).toBe(true)
  })

  it('reports a target the point already meets', () => {
    expect(findReach(LOAD, parseTarget({ circle: { family: 'r', value: 0.6 } }), ['seriesL'], 0, F, Z0).ok).toBe(true)
  })
})

describe('reading answers', () => {
  it('numbers, as people write them', () => {
    expect(parseNumber('2.04:1')).toBe(2.04)
    expect(parseNumber('about 9.3 dB')).toBe(9.3)
    expect(parseNumber('−0.5')).toBe(-0.5)
    expect(parseNumber('.35')).toBe(0.35)
    expect(parseNumber('0.34∠121°', true)).toBe(121)
    expect(parseNumber('121°', true)).toBe(121)
    expect(parseNumber('no idea')).toBeNull()
  })

  it('complex numbers in every common form', () => {
    expect(parseComplex('0.6 + j0.4')).toEqual(c(0.6, 0.4))
    expect(parseComplex('1.15 − j0.77')).toEqual(c(1.15, -0.77))
    expect(parseComplex('0.6-0.4j')).toEqual(c(0.6, -0.4))
    expect(parseComplex('30 + j 20 Ω')).toEqual(c(30, 20))
    expect(parseComplex('23.1 - j15.4 mS')).toEqual(c(23.1, -15.4))
    expect(parseComplex('-j0.5')).toEqual(c(0, -0.5))
    expect(parseComplex('j')).toEqual(c(0, 1))
    expect(parseComplex('1 + i2')).toEqual(c(1, 2))
    expect(parseComplex('0.5')).toEqual(c(0.5, 0))
    expect(parseComplex('somewhere up top')).toBeNull()
  })
})

describe('grading questions (exact, never by the model)', () => {
  const m = metricsFromZ(LOAD, Z0, F)
  const key = (quantity: QuestionKey & { type: 'value' } extends infer K ? K extends { quantity: infer Q } ? Q : never : never): QuestionKey =>
    ({ type: 'value', quantity, expected: expectedValue(m, quantity), tolPct: 5, z0: Z0 })

  it('VSWR within 5% is right; a reading 10% off is not; text that isn\'t a number is asked again', () => {
    expect(m.vswr).toBeCloseTo(2.04, 2)
    expect(gradeQuestion(key('vswr'), { text: '2' }).status).toBe('correct')
    expect(gradeQuestion(key('vswr'), { text: '2.25:1' }).status).toBe('wrong')
    const bad = gradeQuestion(key('vswr'), { text: 'high-ish' })
    expect(bad.status).toBe('unreadable')
    expect(bad.shown).toMatch(/Write a number/)
  })

  it('complex answers: y read off the chart', () => {
    expect(gradeQuestion(key('y'), { text: '1.15 - j0.77' }).status).toBe('correct')
    expect(gradeQuestion(key('y'), { text: '1.15 + j0.77' }).status).toBe('wrong') // the classic sign slip
    expect(gradeQuestion(key('Z_ohm'), { text: '30 + j20 ohm' }).status).toBe('correct')
  })

  it('angles wrap around, and the tutor (not the learner) is told the exact value', () => {
    const k: QuestionKey = { type: 'value', quantity: 'gamma_angle_deg', expected: -179, tolPct: 5, z0: Z0 }
    expect(gradeQuestion(k, { text: '180' }).status).toBe('correct')
    const g = gradeQuestion(key('gamma_angle_deg'), { text: '90' })
    expect(g.status).toBe('wrong')
    expect(g.shown).toBe('not quite')
    expect(g.detail).toMatch(/exact value 120\.96\d°.*allowed ±4\.5/)
  })

  it('small values get an absolute floor so they are not graded impossibly tight', () => {
    const k: QuestionKey = { type: 'value', quantity: 'gamma_mag', expected: 0.05, tolPct: 5, z0: Z0 }
    expect(gradeQuestion(k, { text: '0.065' }).status).toBe('correct')
    expect(gradeQuestion(k, { text: '0.1' }).status).toBe('wrong')
  })

  it('a click is graded by its distance on the chart', () => {
    const target = gammaFromZ(c(1, -1), 1)
    const k: QuestionKey = { type: 'locate', target, tol: 0.06, targetText: 'z = 1 − j1' }
    expect(gradeQuestion(k, { gamma: c(target.re + 0.03, target.im) }).status).toBe('correct')
    const far = gradeQuestion(k, { gamma: gammaFromZ(c(1, 1), 1) })
    expect(far.status).toBe('wrong')
    expect(far.detail).toMatch(/clicked z = 1 \+ j1/)
    expect(gradeQuestion(k, {}).status).toBe('unreadable')
  })
})

describe('move questions: the right answer comes from the move calculator', () => {
  const at = (kind: Parameters<typeof applyElement>[1]['kind'], value: number) => ({ id: 'q', kind, value, zc: Z0, refHz: F })

  it('each lumped element from 30 + j20 Ω', () => {
    const q = (kind: Parameters<typeof at>[0], v: number) => {
      const r = moveQuestion(LOAD, at(kind, v), F, Z0)
      return r.choices[r.correct]
    }
    expect(q('shuntC', 2e-12)).toBe('Clockwise along its constant-g circle')
    expect(q('seriesL', 1e-9)).toBe('Clockwise along its constant-r circle')
    expect(q('seriesC', 5e-12)).toBe('Counter-clockwise along its constant-r circle')
    expect(q('shuntL', 10e-9)).toBe('Counter-clockwise along its constant-g circle')
  })

  it('a line turns clockwise around the centre; which half the shunt C ends in', () => {
    const line = moveQuestion(LOAD, at('tline', 45), F, Z0)
    expect(line.choices[line.correct]).toBe('Clockwise around the chart centre')
    const half = moveQuestion(LOAD, at('shuntC', 2e-12), F, Z0, 'end_half')
    expect(half.choices[half.correct]).toBe('It ends in the lower half')
    // Grading uses that key.
    expect(gradeQuestion({ type: 'move', ...half }, { choice: 'It ends in the lower half' }).status).toBe('correct')
    expect(gradeQuestion({ type: 'move', ...half }, { choice: 'It ends in the upper half' }).status).toBe('wrong')
  })

  it('refuses questions with no single right direction', () => {
    expect(() => moveQuestion(LOAD, at('seriesR', 10), F, Z0)).toThrow(/doesn't turn/)
    expect(() => moveQuestion(LOAD, { ...at('tline', 45), zc: 75 }, F, Z0)).toThrow(/Zc equals Z0/)
  })

  it('agrees with the physics for the same element and value used on the chart', () => {
    // Shunt C 2 pF: ωC·Z0 = 0.75 added to b = −0.77 → b ≈ −0.02: still upper by a hair? The calculator decides, not us.
    const end = applyElement(LOAD, at('shuntC', 2e-12), F)
    const y = admittanceOf(c(end.re / Z0, end.im / Z0))
    const half = moveQuestion(LOAD, at('shuntC', 2e-12), F, Z0, 'end_half')
    expect(half.choices[half.correct]).toBe(y.im > 0 ? 'It ends in the lower half' : 'It ends in the upper half')
    expect(W * 2e-12 * Z0).toBeCloseTo(1.508, 2)
  })
})

describe('ohmsIn: impedances a question states in ohms', () => {
  it('reads complex, real and word forms, with a decimal comma or a typographic minus', async () => {
    const { ohmsIn } = await import('./tasks')
    expect(ohmsIn('Your load is 100 + j50 Ω with Z0 = 50 Ω.')).toEqual([{ re: 100, im: 50 }, { re: 50, im: 0 }])
    expect(ohmsIn('a 25 − j25 ohm load')).toEqual([{ re: 25, im: -25 }])
    expect(ohmsIn('Z = 30,5 - 20j Ω')).toEqual([{ re: 30.5, im: -20 }])
    expect(ohmsIn('R 30 Ω, X −20 Ω')).toEqual([{ re: 30, im: 0 }, { re: -20, im: 0 }])
    expect(ohmsIn('z = 2 + j1 on the chart')).toEqual([])
  })
})
