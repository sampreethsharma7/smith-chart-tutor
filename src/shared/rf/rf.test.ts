import { describe, expect, it } from 'vitest'
import { c, abs } from './complex'
import { gammaFromZ, metricsFromZ, zFromGamma } from './metrics'
import { computeTrace, inputImpedance, loadImpedance, sweepFreqs, traceBands, NetworkElement } from './network'
import { parseCstAscii, parseTouchstone, importFile } from './importers'

const close = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol)

describe('metrics', () => {
  it('matched load', () => {
    const m = metricsFromZ(c(50, 0), 50)
    close(m.gammaMag, 0)
    close(m.vswr, 1)
    expect(m.returnLossDb).toBe(Infinity)
  })

  it('100 Ω on 50 Ω: Γ = 1/3, VSWR 2', () => {
    const m = metricsFromZ(c(100, 0), 50)
    close(m.gammaMag, 1 / 3)
    close(m.vswr, 2)
    close(m.returnLossDb, 9.5424, 1e-3)
    close(m.mismatchLossDb, 0.5115, 1e-3)
    close(m.wtg, 0.25) // on the right half of the real axis
  })

  it('Q and equivalent components', () => {
    const f = 1e9
    const m = metricsFromZ(c(25, 50), 50, f)
    close(m.q, 2)
    expect(m.seriesEquivalent?.kind).toBe('L')
    close(m.seriesEquivalent!.value, 50 / (2 * Math.PI * f), 1e-15)
  })

  it('Γ ↔ Z round trip', () => {
    const z = c(13, -42)
    const back = zFromGamma(gammaFromZ(z, 50), 50)
    close(back.re, 13)
    close(back.im, -42)
  })

  it('WTG is 0 at the short circuit', () => {
    close(metricsFromZ(c(1e-9, 0), 50).wtg % 0.5, 0, 1e-6)
  })
})

describe('network', () => {
  const f = 1e9
  const w = 2 * Math.PI * f

  it('L-match 25 Ω → 50 Ω (series L, shunt C)', () => {
    // Load 25 Ω. Series X = +25 Ω gives Y = 0.02 − j0.02 S; shunt B = +0.02 S cancels it → 50 Ω.
    const net: NetworkElement[] = [
      { id: 'a', kind: 'seriesL', value: 25 / w },
      { id: 'b', kind: 'shuntC', value: 0.02 / w }
    ]
    const zin = inputImpedance(c(25, 0), net, f)
    close(zin.re, 50, 1e-6)
    close(zin.im, 0, 1e-6)
  })

  it('quarter-wave transformer', () => {
    const net: NetworkElement[] = [{ id: 't', kind: 'tline', value: 90, zc: Math.sqrt(50 * 200), refHz: f }]
    const zin = inputImpedance(c(200, 0), net, f)
    close(zin.re, 50, 1e-6)
    close(zin.im, 0, 1e-6)
  })

  it('half-wave line repeats the load', () => {
    const net: NetworkElement[] = [{ id: 't', kind: 'tline', value: 180, zc: 75, refHz: f }]
    const zin = inputImpedance(c(30, 20), net, f)
    close(zin.re, 30, 1e-6)
    close(zin.im, 20, 1e-6)
  })

  it('series RLC resonates at 1/(2π√LC)', () => {
    const L = 10e-9
    const C = 1 / (w * w * L)
    const z = loadImpedance({ kind: 'seriesRLC', R: 50, L, C }, f)
    close(z.im, 0, 1e-6)
  })

  it('antenna model bandwidth ≈ (VSWR−1)/(Q√VSWR)', () => {
    const load = { kind: 'antenna' as const, topology: 'series' as const, f0: 1e9, R: 50, Q: 10 }
    const tr = computeTrace(load, [], sweepFreqs({ start: 0.8e9, stop: 1.2e9, points: 4001 }), 50)
    const [band] = traceBands(tr, 50, 2)
    close(band.fractional, 1 / (10 * Math.SQRT2), 2e-3)
  })
})

describe('importers', () => {
  it('Touchstone s1p RI in MHz', () => {
    const ds = parseTouchstone('! test\n# MHz S RI R 50\n100 0.5 0\n200 0 0.5\n', { name: 'a.s1p' })
    expect(ds.freqs).toEqual([100e6, 200e6])
    close(ds.gamma[1].im, 0.5)
  })

  it('Touchstone s2p DB uses S11', () => {
    const ds = importFile('b.s2p', '# GHz S DB R 50\n1 -6.0206 90 -1 0 -1 0 -20 0\n')[0]
    close(abs(ds.gamma[0]), 0.5, 1e-4)
    close(ds.gamma[0].im, 0.5, 1e-4)
  })

  it('CST ASCII Re/Im with header', () => {
    const txt = `#"Frequency / GHz"\t"Re(S1,1)"\t"Im(S1,1)"\n#----\n2.0\t0.1\t-0.2\n2.5\t0.0\t0.0\n`
    const [ds] = parseCstAscii(txt, 'cst.txt')
    expect(ds.freqs[0]).toBe(2e9)
    close(ds.gamma[0].im, -0.2)
  })

  it('CST ASCII dB + phase guessed from data', () => {
    const txt = 'Frequency / MHz   S1,1\n----\n900 -6.0206 180\n950 -20 45\n'
    const [ds] = parseCstAscii(txt, 'cst.txt')
    expect(ds.freqs[0]).toBe(900e6)
    close(ds.gamma[0].re, -0.5, 1e-4)
  })

  it('CST magnitude-only export is rejected with guidance', () => {
    expect(() => parseCstAscii('Frequency / GHz   S1,1/abs,dB\n1 -10\n2 -12\n', 'x.txt')).toThrow(/phase/)
  })

  it('multiple blocks become multiple datasets', () => {
    const txt = '#"Frequency / GHz" "Re(S1,1)" "Im(S1,1)" (w=1)\n1 0 0\n2 0 0\n#"Frequency / GHz" "Re(S1,1)" "Im(S1,1)" (w=2)\n1 0.1 0\n2 0.1 0\n'
    expect(parseCstAscii(txt, 'sweep.txt')).toHaveLength(2)
  })
})

import { solveLMatch, toNetwork } from './solvers'
import { QUESTIONS, grade } from '../assessment'

describe('L-match solver', () => {
  const f = 2.4e9
  const loads = [c(25, 0), c(25, 40), c(120, -80), c(10, -5), c(200, 300), c(48, 20)]
  for (const ZL of loads) {
    it(`matches ${ZL.re}${ZL.im >= 0 ? '+' : ''}${ZL.im}j to 50 Ω`, () => {
      const sols = solveLMatch(ZL, 50, f)
      expect(sols.length).toBeGreaterThan(0)
      for (const s of sols) {
        const zin = inputImpedance(ZL, toNetwork(s), f)
        close(zin.re, 50, 1e-6)
        close(zin.im, 0, 1e-6)
      }
    })
  }
})

describe('assessment answer key agrees with the RF engine', () => {
  const q = (id: string) => QUESTIONS.find((x) => x.id === id)!
  it('click targets', () => {
    expect(grade(q('cb1'), gammaFromZ(c(1, 1), 1))).toBe(true)
    expect(grade(q('ad2'), gammaFromZ(c(1, -1), 1))).toBe(true) // y = 1 − j1 sits where z = 1 − j1 would
    const show = (q('ad2') as { show: { re: number; im: number } }).show
    const g = gammaFromZ(c(0.5, 0.5), 1)
    close(show.re, g.re)
    close(show.im, g.im)
  })
  it('numeric answers', () => {
    expect(grade(q('rf1'), metricsFromZ(c(150, 0), 50).vswr)).toBe(true) // |Γ| = 0.5
    expect(grade(q('rf2'), metricsFromZ(c(100, 0), 50).returnLossDb)).toBe(true)
    expect(grade(q('qb1'), metricsFromZ(c(0.5, 1.5), 1).q)).toBe(true)
    const lm = solveLMatch(c(25, 0), 50, 1e9).find((s) => s.topology === 'series-first' && s.elements[0].kind === 'seriesL')!
    expect(grade(q('lmt1'), lm.elements[0].reactanceOhm!)).toBe(true)
  })
})

import { parseNumericAnswer } from '../assessment'
describe('numeric answer parsing', () => {
  it('accepts units, Unicode minus and decimal comma', () => {
    expect(parseNumericAnswer('9.54 dB')).toBe(9.54)
    expect(parseNumericAnswer('100 Ω')).toBe(100)
    expect(parseNumericAnswer('−0.8')).toBe(-0.8)
    expect(parseNumericAnswer('0,5 λ')).toBe(0.5)
    expect(parseNumericAnswer('.5')).toBe(0.5)
    expect(parseNumericAnswer('about 3')).toBe(3)
    expect(Number.isNaN(parseNumericAnswer('no idea'))).toBe(true)
  })
})

import { countsAsLesson, createProfile, exportProfile, lessonsOf, masterySnapshot, migrateProfile, skillChanges } from '../profile'
describe('lessons', () => {
  const base = { id: 's', startedAt: 'x', exercises: [] }
  it('only counts lessons the learner took part in', () => {
    const opened = { ...base, transcript: [{ role: 'tutor' as const, text: 'Hi! Goal…', at: 'x' }] }
    const answered = { ...base, transcript: [...opened.transcript, { role: 'user' as const, text: 'Inside the circle', at: 'x' }] }
    const checked = { ...base, transcript: [], exercises: [{ title: 'Match', passed: false, attempts: 1, at: 'x' }] }
    expect(countsAsLesson(opened)).toBe(false)
    expect(countsAsLesson(answered)).toBe(true)
    expect(countsAsLesson(checked)).toBe(true)
    const p = createProfile('Me')
    p.sessions = [opened, answered, opened]
    expect(lessonsOf(p)).toHaveLength(1)
  })
  it('reports how skills moved over a lesson', () => {
    const p = createProfile('Me')
    const start = masterySnapshot(p.skills)
    p.skills.l_match = { ...p.skills.l_match, mastery: p.skills.l_match.mastery + 0.2 }
    const s = { ...base, transcript: [], skillsAtStart: start, skillsAtEnd: masterySnapshot(p.skills) }
    const changes = skillChanges(s, createProfile('Later').skills) // uses the end snapshot, not today's skills
    expect(changes).toHaveLength(1)
    expect(changes[0].id).toBe('l_match')
    expect(changes[0].to - changes[0].from).toBeCloseTo(0.2)
  })
})

describe('profile export/import', () => {
  it('export keeps history but never an in-progress test', () => {
    const p = createProfile('Me')
    p.setupComplete = true
    p.sessions.push({ id: 's1', startedAt: 'x', transcript: [{ role: 'user', text: 'hi', at: 'x' }], exercises: [] })
    p.assessmentDraft = { questions: [], idx: 3, answers: [], feedback: null, shownAt: 0, startedAt: 'x' }
    const full = migrateProfile(JSON.parse(JSON.stringify(exportProfile(p))))
    expect(full.setupComplete).toBe(true)
    expect(full.sessions).toHaveLength(1)
    expect(full.assessmentDraft).toBeUndefined()
  })
  it('older profiles without the setup flag count as set up once used', () => {
    const old = { ...createProfile('Old'), sessions: [{ id: 's', startedAt: 'x', transcript: [], exercises: [] }] } as Record<string, unknown>
    delete old.setupComplete
    expect(migrateProfile(old as never).setupComplete).toBe(true)
  })
})

import { fitScore } from '../benchmark'
describe('adaptive model ranking', () => {
  const fast = { overall: 0, speed: 1, guiding: 0.4, tools: 0.5 }
  const smart = { overall: 0, speed: 0.3, guiding: 0.95, tools: 0.95 }
  it('re-ranks when the user changes which attributes matter', () => {
    expect(fitScore(fast, ['speed'])).toBeGreaterThan(fitScore(smart, ['speed']))
    expect(fitScore(smart, ['guiding', 'tools'])).toBeGreaterThan(fitScore(fast, ['guiding', 'tools']))
  })
  it('ignores attributes a report has no score for', () => {
    expect(fitScore({ overall: 0, speed: 0.8 }, ['speed', 'summary'])).toBeCloseTo(0.8)
  })
})
