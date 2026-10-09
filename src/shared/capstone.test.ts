import { describe, expect, it } from 'vitest'
import { createProfile, migrateProfile, resetProgress, type Profile, type SkillId } from './profile'
import { learnerBrief } from './memory'
import { capstoneBrief, makeCapstone, milestones, routeOf, stageOf, titleOf, upNext, type Capstone } from './capstone'
import type { Rung } from './ladder'

const AT = '2026-10-09T12:00:00.000Z'
const fresh = (): Profile => migrateProfile(createProfile('Riya', { experience: 'new' }))
const ANTENNA = { kind: 'antenna' as const, topology: 'parallel' as const, f0: 2.44e9, R: 40, Q: 8 }
const project = (x: Partial<Parameters<typeof makeCapstone>[0]> = {}): Capstone =>
  makeCapstone({ load: ANTENNA, f0: 2.44e9, maxVswr: 2, parts: 'lumped', setBy: 'tutor', at: AT, ...x })
const BAND = { low: 2.4e9, high: 2.48e9 }
const route = (c: Capstone) => routeOf(c).map((x) => `${x.skill}:${x.need.kind === 'chart' ? 'chart' : x.need.rung}`)
/** Confirmed by answers: a rung on the ladder, or reading from the chart. */
const at = (p: Profile, skill: SkillId, rung: Rung, provisional = false): Profile =>
  ({ ...p, ladder: { ...(p.ladder ?? {}), [skill]: { rung, streak: 0, misses: 0, tries: 0, source: provisional ? 'related' : 'answers', at: AT, ...(provisional ? { provisional } : {}) } } })
const reads = (p: Profile, skill: SkillId, provisional = false): Profile =>
  ({ ...p, reading: { ...(p.reading ?? {}), [skill]: { stage: 'chart', streak: 0, misses: 0, source: provisional ? 'start' : 'answers', at: AT, ...(provisional ? { provisional } : {}) } } })

describe('a project is its settings; the title follows them', () => {
  it('says what, where, how well and with what', () => {
    expect(titleOf(project({ band: BAND }))).toBe('Match a 2.44 GHz patch-like antenna across 2.4 GHz–2.48 GHz to VSWR ≤ 2 with L and C parts')
    expect(titleOf(project({ load: { kind: 'data', datasetName: 'patch_v3.s1p' }, parts: 'any' }))).toBe('Match your patch_v3.s1p data at 2.44 GHz to VSWR ≤ 2')
    expect(titleOf(project({ load: { kind: 'fixed', R: 25, X: -40 }, parts: 'lines', maxVswr: 1.5, f0: 915e6 }))).toBe('Match 25 − j40 Ω at 915 MHz to VSWR ≤ 1.5 with a line and a stub')
    expect(titleOf(project({ judge: true }))).toMatch(/^Judge worked L-matches/)
  })

  it('checks the settings, with reasons to act on', () => {
    expect(() => project({ f0: 10 })).toThrow(/between 1 MHz and 100 GHz/)
    expect(() => project({ band: { low: 2.5e9, high: 2.6e9 } })).toThrow(/must sit inside the band/)
    expect(() => project({ band: { low: 1e9, high: 3e9 }, f0: 2e9 })).toThrow(/wider than an octave/)
    expect(() => project({ maxVswr: 1 })).toThrow(/between 1.05 and 5/)
  })
})

describe('the route comes from the settings (no project types)', () => {
  it('a lumped match at one frequency: read the chart, choose parts, plan whole matches', () => {
    expect(route(project())).toEqual(['chart_basics:chart', 'reflection:chart', 'admittance:chart', 'lumped_moves:2', 'l_match:3'])
  })

  it('a band adds Q & bandwidth (band items count there, not toward L-matching); a tight VSWR makes the match constrained', () => {
    expect(route(project({ band: BAND }))).toEqual(['chart_basics:chart', 'reflection:chart', 'admittance:chart', 'lumped_moves:2', 'l_match:3', 'q_bandwidth:4'])
    expect(route(project({ maxVswr: 1.2 }))).toContain('l_match:4')
  })

  it('lines and stubs take that route (a line + stub match is a stubs item; lines at "one choice"); a band adds only Q & bandwidth', () => {
    expect(route(project({ parts: 'lines' }))).toEqual(['chart_basics:chart', 'reflection:chart', 'admittance:chart', 'tlines:2', 'stubs:3'])
    expect(route(project({ parts: 'lines', maxVswr: 1.2 }))).toContain('stubs:4')
    expect(route(project({ parts: 'lines', band: BAND }))).toEqual(['chart_basics:chart', 'reflection:chart', 'admittance:chart', 'tlines:2', 'stubs:3', 'q_bandwidth:4'])
  })

  it('a judge project ends at judging worked matches, with no build', () => {
    expect(route(project({ judge: true, band: BAND }))).toEqual(['chart_basics:chart', 'reflection:chart', 'admittance:chart', 'lumped_moves:2', 'l_match:5'])
  })
})

describe('milestones are ticked from their own answers, and the stages follow', () => {
  const allMet = (p: Profile) => at(at(reads(reads(reads(p, 'chart_basics'), 'reflection'), 'admittance'), 'lumped_moves', 2), 'l_match', 3)

  it('an estimate does not tick a milestone; a confirmed rung or reading does (a higher rung too)', () => {
    const c = project()
    expect(milestones(at(fresh(), 'lumped_moves', 2, true), c).find((x) => x.skill === 'lumped_moves')!.met).toBe(false)
    expect(milestones(at(fresh(), 'lumped_moves', 5), c).find((x) => x.skill === 'lumped_moves')!.met).toBe(true)
    expect(milestones(reads(fresh(), 'reflection', true), c).find((x) => x.skill === 'reflection')!.met).toBe(false)
    expect(milestones(reads(fresh(), 'reflection'), c).find((x) => x.skill === 'reflection')!.met).toBe(true)
  })

  it('route → final task → done', () => {
    const c = project()
    expect(stageOf(fresh(), c)).toBe('route')
    expect(stageOf(allMet(fresh()), c)).toBe('final')
    expect(stageOf(allMet(fresh()), { ...c, done: { at: AT } })).toBe('done')
    // A judge project is done when its milestones are: there is no task to pass.
    const j = project({ judge: true })
    expect(stageOf(at(allMet(fresh()), 'l_match', 5), j)).toBe('done')
  })

  it('"Up next" names the next step toward the project, then the final task', () => {
    const p = { ...reads(reads(reads(fresh(), 'chart_basics'), 'reflection'), 'admittance'), capstone: project() }
    expect(upNext(p)).toBe('Next step toward your project: Series/shunt L & C moves: choosing the part yourself.')
    const q = { ...at(at(p, 'lumped_moves', 2), 'l_match', 1), capstone: project() }
    expect(upNext(q)).toBe('Next step toward your project: L-network matching: choosing the part yourself.')
    expect(upNext({ ...allMet(fresh()), capstone: project() })).toMatch(/^Your project's final task is open: Match a 2\.44 GHz/)
    expect(upNext({ ...allMet(fresh()), capstone: { ...project(), done: { at: AT } } })).toBeNull()
  })

  it('with no project, "Up next" is the next step up on the first skill of the tutor\'s plan', () => {
    const p = { ...at(fresh(), 'l_match', 2), nextFocus: { picks: [{ skill: 'l_match' as SkillId, why: 'x' }], at: AT } }
    expect(upNext(p)).toBe('Next: L-network matching: planning whole matches yourself.')
    expect(upNext({ ...fresh(), nextFocus: { picks: [{ skill: 'reflection' as SkillId, why: 'x' }], at: AT } })).toBe('Next: Γ, VSWR & return loss: reading values from the chart yourself.')
    expect(upNext(fresh())).toBeNull()
  })

  it('review: after a project is done, "Up next" falls back to the plan; a skill not yet on the ladder still has a next step', () => {
    const plan = { picks: [{ skill: 'stubs' as SkillId, why: 'x' }], at: AT }
    expect(upNext({ ...fresh(), nextFocus: plan })).toBe('Next: Stub matching: choosing the part yourself.')
    expect(upNext({ ...fresh(), nextFocus: plan, capstone: { ...project(), done: { at: AT } } })).toBe('Next: Stub matching: choosing the part yourself.')
  })
})

describe('the tutor plans toward it; it is saved with the profile', () => {
  it('the brief has the project, the route and what to do', () => {
    expect(capstoneBrief(fresh())).toMatch(/none yet\. Propose one from their goals with set_capstone/)
    const p = { ...fresh(), capstone: project() }
    const b = capstoneBrief(p)
    expect(b).toMatch(/Project \(capstone, set by you\): "Match a 2\.44 GHz patch-like antenna at 2\.44 GHz to VSWR ≤ 2 with L and C parts"/)
    expect(b).toMatch(/Next milestone: Chart anatomy & normalization: reading values from the chart yourself \(items that move it: a reading question \(ask_value \/ ask_locate\) with the values covered\)\. Prefer work that moves it/)
    // Where it isn't obvious which items count, the brief says.
    const stubsNext = { ...p, capstone: project({ parts: 'lines' }), reading: Object.fromEntries((['chart_basics', 'reflection', 'admittance'] as SkillId[]).map((k) => [k, { stage: 'chart', streak: 0, misses: 0, source: 'answers', at: AT }])), ladder: { tlines: { rung: 2 as Rung, streak: 0, misses: 0, tries: 0, source: 'answers' as const, at: AT } } }
    expect(capstoneBrief(stubsNext as Profile)).toMatch(/Next milestone: Stub matching: planning whole matches yourself \(items that move it: create_exercise with a stub \(openStub \/ shortStub\) in allowed_kinds/)
    expect(capstoneBrief({ ...p, capstone: { ...project(), setBy: 'learner' } })).toMatch(/set by the learner: change it only if they ask/)
    expect(learnerBrief(p, AT).text).toContain(b)
  })

  it('survives saving and loading; Reset progress clears it', () => {
    const p = { ...fresh(), capstone: project({ band: BAND }) }
    expect(migrateProfile(JSON.parse(JSON.stringify(p))).capstone).toEqual(p.capstone)
    expect(resetProgress(p).capstone).toBeUndefined()
  })
})
