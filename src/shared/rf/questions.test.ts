import { describe, expect, it } from 'vitest'
import katex from 'katex'
import { c } from './complex'
import { describeMove } from './moves'
import { applyElement, inputImpedance, type ElementKind } from './network'
import { solveLMatch, toNetwork } from './solvers'
import { gradeQuestion, moveQuestion, regionOf } from './tasks'
import { MISTAKES, spotQuestion } from './spot'
import { splitMath } from '../../renderer/src/components/mathText'
import { classifyMove, recordGraded } from '../memory'
import { createProfile } from '../profile'

const F = 2.4e9
const Z0 = 50

describe('two-part move questions: the answer and why', () => {
  const kinds: ElementKind[] = ['seriesL', 'seriesC', 'shuntL', 'shuntC', 'tline', 'openStub', 'shortStub']
  for (const kind of kinds) {
    it(`${kind}: the right reason matches the physics of the move`, () => {
      for (const Z of [c(30, 20), c(80, -40), c(10, -5)]) {
        const el = { id: 'x', kind, value: kind === 'tline' || kind.endsWith('Stub') ? 30 : kind.endsWith('L') ? 3e-9 : 2e-12, zc: Z0, refHz: F }
        const q = moveQuestion(Z, el, F, Z0)
        const r = q.reasons!
        const right = r.choices[r.correct]
        const cw = describeMove(Z, el, F, Z0).rotation === 'clockwise'
        if (kind === 'tline') expect(right).toMatch(cw ? /Toward the generator/ : /Toward the load/)
        else if (kind.startsWith('series')) expect(right).toMatch(cw ? /adds \+jx/ : /adds −jx/)
        else expect(right).toMatch(cw ? /adds \+jb/ : /adds −jb/)
        // And the numbers agree: a series part really changes x that way, a shunt part b.
        const after = applyElement(Z, el, F)
        if (kind.startsWith('series')) expect(Math.sign(after.im - Z.im)).toBe(cw ? 1 : -1)
        if (kind.startsWith('shunt') || kind.endsWith('Stub')) {
          const b = (z: { re: number; im: number }) => -z.im / (z.re * z.re + z.im * z.im)
          expect(Math.sign(b(after) - b(Z))).toBe(cw ? 1 : -1)
        }
        // Every wrong reason names the idea it shows, about this element.
        r.ideas.forEach((idea, i) => i !== r.correct && expect(idea).toMatch(/^Thinks a [a-z]/))
      }
    })
  }

  it('grading: both right = correct; right answer, wrong reason = partial; wrong answer = wrong; no reason = asked for it', () => {
    const q = moveQuestion(c(30, 20), { id: 'x', kind: 'seriesL', value: 3e-9 }, F, Z0)
    const key = { type: 'move' as const, choices: q.choices, correct: q.correct, facts: q.facts, reasons: q.reasons }
    const goodWhy = q.reasons!.choices[q.reasons!.correct]
    const badWhy = q.reasons!.choices.find((_, i) => i !== q.reasons!.correct)!
    expect(gradeQuestion(key, { choice: q.choices[q.correct], reason: goodWhy }).status).toBe('correct')
    const partial = gradeQuestion(key, { choice: q.choices[q.correct], reason: badWhy })
    expect(partial.status).toBe('partial')
    expect(partial.detail).toMatch(/^RIGHT ANSWER, WRONG REASON/)
    expect(gradeQuestion(key, { choice: q.choices[(q.correct + 1) % 4], reason: goodWhy }).status).toBe('wrong')
    expect(gradeQuestion(key, { choice: q.choices[q.correct] }).status).toBe('unreadable')
  })

  it('with a reason the question is a level harder', () => {
    expect(classifyMove('seriesL', 'path').difficulty).toBe(1)
    expect(classifyMove('seriesL', 'path', true).difficulty).toBe(2)
    expect(classifyMove('tline', 'path', true).difficulty).toBe(3)
    expect(classifyMove('seriesL', 'end_half', true).difficulty).toBe(2)
  })
})

describe('spot the mistake', () => {
  const loads = [c(30, 20), c(150, -40), c(10, 25), c(120, 60)]

  for (const mistake of MISTAKES) {
    it(`${mistake}: the app knows where it is, every formula renders, and the rest of the solution is right`, () => {
      for (const ZL of loads) {
        const q = spotQuestion(ZL, Z0, F, mistake)
        expect(q.choices).toHaveLength(5)
        expect(q.correct).toBe({ normalise: 0, direction: 1, circle: 1, element: 1, formula: 3, none: 4 }[mistake])
        for (const p of splitMath(q.body)) if (p.math) expect(() => katex.renderToString(p.math!, { throwOnError: true }), p.math).not.toThrow()
        expect(q.body.split('**Step ').length - 1).toBe(4)
        if (mistake === 'none') expect(q.missedIdea).toBeUndefined()
        else expect(q.missedIdea).toMatch(/^Accepts /)
      }
    })
  }

  it('the solution it shows really matches the load', () => {
    for (const ZL of loads) {
      const sol = solveLMatch(ZL, Z0, F).filter((s) => s.elements.length === 2)[0]
      const zin = inputImpedance(ZL, toNetwork(sol), F)
      expect(zin.re).toBeCloseTo(Z0, 6)
      expect(zin.im).toBeCloseTo(0, 6)
      const q = spotQuestion(ZL, Z0, F, 'none')
      expect(q.facts).toMatch(/no mistake/)
    }
  })

  it('a planted mistake really differs from the truth', () => {
    const ZL = c(30, 20)
    const right = spotQuestion(ZL, Z0, F, 'none').body.split('\n\n')
    for (const [m, step] of [['normalise', 1], ['direction', 2], ['circle', 2], ['element', 2], ['formula', 4]] as const) {
      const wrong = spotQuestion(ZL, Z0, F, m).body.split('\n\n')
      expect(wrong[step], m).not.toBe(right[step])
      // Only that step differs.
      wrong.forEach((line, i) => i !== step && expect(line, `${m} step ${i}`).toBe(right[i]))
    }
  })

  it('files each mistake under the topic it tests', () => {
    expect(spotQuestion(c(30, 20), Z0, F, 'normalise').topic).toBe('read_z')
    expect(spotQuestion(c(30, 20), Z0, F, 'direction').topic).toMatch(/^dir_/)
    expect(spotQuestion(c(30, 20), Z0, F, 'circle').topic).toBe('land_lumped')
    expect(spotQuestion(c(30, 20), Z0, F, 'formula')).toMatchObject({ topic: 'l_match', difficulty: 3 })
  })
})

describe('situations and probes', () => {
  it('names where a point is', () => {
    expect(regionOf(c(0.6, 0.4))).toBe('upper half, r < 1')
    expect(regionOf(c(2, -1))).toBe('lower half, r ≥ 1')
    expect(regionOf(c(1.5, 0))).toBe('real axis, r ≥ 1')
  })

  it('after a clean right answer: probe up, and change the situation; after a miss: probe down', () => {
    const p = createProfile('A')
    const base = { meta: { topic: 'dir_shuntL' as const, skill: 'lumped_moves' as const, difficulty: 2 as const, ctx: 'upper half, r < 1' }, label: 'q', session: 's', at: '2026-10-07T00:00:00Z', format: 'click' as const }
    const right = recordGraded(p, { ...base, outcome: 'correct', sure: 'sure' })
    expect(right.report).toMatch(/probe up: next time on this topic, ask at level 3/)
    expect(right.report).toMatch(/all their right answers on this topic are in one situation \(upper half, r < 1\): next time change it/)
    const miss = recordGraded(p, { ...base, outcome: 'incorrect', sure: 'unsure' })
    expect(miss.report).toMatch(/probe down: ask this topic at level 1/)
    const again = recordGraded(right.profile, { ...base, meta: { ...base.meta, ctx: 'lower half, r ≥ 1' }, outcome: 'correct', sure: 'sure' })
    expect(again.report).not.toMatch(/one situation/)
  })
})

describe('a planted mistake is not given away by an absurd number', () => {
  it('the forgotten-2π slip keeps the formula and a plausible size (off by 2π, same prefix range)', () => {
    for (const ZL of [c(30, 20), c(150, -40), c(10, 25), c(120, 60)]) {
      const right = spotQuestion(ZL, Z0, F, 'none').body.split('\n\n')[4]
      const wrong = spotQuestion(ZL, Z0, F, 'formula').body.split('\n\n')[4]
      // Same formulas; only the numbers (and maybe the prefix) differ.
      const shape = (t: string) => t.replace(/-?[\d.]+(\\times10\^\{-?\d+\})?/g, '#').replace(/\\text\{[a-zA-Z]\}/g, '').replace(/\\mu/g, '')
      expect(shape(wrong)).toBe(shape(right))
      expect(wrong).not.toMatch(/\\text\{(G|M|k)\}/)
      expect(wrong).not.toBe(right)
    }
  })
})

describe('reading a part value', () => {
  it('value with its unit; the unit is required', async () => {
    const { parsePartValue } = await import('./tasks')
    expect(parsePartValue('2.7 nH')).toEqual({ value: 2.7e-9, unit: 'H' })
    expect(parsePartValue('1.1pF')!.value).toBeCloseTo(1.1e-12, 20)
    expect(parsePartValue('0,9 pF')!.value).toBeCloseTo(0.9e-12, 20)
    expect(parsePartValue('3.3e-9 H')).toEqual({ value: 3.3e-9, unit: 'H' })
    expect(parsePartValue('2 µH')!.unit).toBe('H')
    expect(parsePartValue('1.1')).toBeNull()
    expect(parsePartValue('lots')).toBeNull()
  })
})
