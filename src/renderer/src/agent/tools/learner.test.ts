import { beforeEach, describe, expect, it } from 'vitest'
import { applyEvidence, createProfile, type Profile } from '@shared/profile'
import { plannedFocus, skillStanding } from '@shared/standing'
import { runTool } from '../registry'
import type { ToolContext } from '../types'

let profile: Profile
const ctx = {
  profile: () => profile,
  updateProfile: async (fn: (p: Profile) => Profile) => { profile = fn(profile) },
  session: () => ({ id: 'lesson-7', models: ['Gemini 3.1 Pro'] }),
  learnerTurns: () => 3
} as unknown as ToolContext

/** Steady right answers at medium difficulty on a skill. */
const practise = (skill: keyof Profile['skills'], n: number, right = true) => {
  let s = profile.skills[skill]
  for (let i = 0; i < n; i++) s = applyEvidence(s, right ? 'correct' : 'incorrect', 2, 'test')
  profile = { ...profile, skills: { ...profile.skills, [skill]: s } }
}

beforeEach(() => {
  profile = createProfile('Sam', { experience: 'basics' })
})

describe('set_next_focus: the tutor decides, everything else shows it', () => {
  it('saves the pick with who set it and when; the Progress page reads exactly that', async () => {
    const r = await runTool('set_next_focus', {
      picks: [
        { skill: 'admittance', topic: 'read_y', why: 'Reading y is the step that trips you up in shunt moves.' },
        { skill: 'reflection', why: 'Two more VSWR reads and this one is solid.' }
      ]
    }, ctx)
    expect(r.isError).toBe(false)
    expect(r.content).toMatch(/Plan saved: 1\. Admittance & Z↔Y \(read_y\), 2\. Γ, VSWR & return loss/)
    expect(profile.nextFocus).toMatchObject({ session: 'lesson-7', model: 'Gemini 3.1 Pro', picks: [{ skill: 'admittance', topic: 'read_y' }, { skill: 'reflection' }] })
    const shown = plannedFocus(profile, skillStanding(profile, new Date().toISOString()))
    expect(shown.map((x) => [x.skill, x.why])).toEqual(profile.nextFocus!.picks.map((x) => [x.skill, x.why]))
  })

  it('replaces the old plan rather than adding to it', async () => {
    await runTool('set_next_focus', { picks: [{ skill: 'admittance', why: 'a' }] }, ctx)
    await runTool('set_next_focus', { picks: [{ skill: 'reflection', why: 'b' }] }, ctx)
    expect(profile.nextFocus!.picks.map((x) => x.skill)).toEqual(['reflection'])
  })

  it('a weak measured prerequisite is advice, not a refusal (the novice test looped 27 times on it)', async () => {
    // Unmeasured, no advice at all.
    const free = await runTool('set_next_focus', { picks: [{ skill: 'l_match', why: 'x' }] }, ctx)
    expect(free.isError).toBe(false)
    expect(free.content).not.toMatch(/Advice/)
    profile = { ...profile, nextFocus: undefined }
    practise('lumped_moves', 3, false)
    const r = await runTool('set_next_focus', { picks: [{ skill: 'l_match', why: 'x' }] }, ctx)
    expect(r.isError).toBe(false)
    expect(profile.nextFocus!.picks.map((x) => x.skill)).toEqual(['l_match'])
    expect(r.content).toMatch(/Advice: l_match builds on lumped_moves \(lumped_moves \d+%, below 50%\): open that lesson with a quick check of lumped_moves/)
    practise('admittance', 6)
    practise('lumped_moves', 6)
    practise('reflection', 6)
    expect((await runTool('set_next_focus', { picks: [{ skill: 'l_match', why: 'x' }] }, ctx)).content).not.toMatch(/Advice/)
  })

  it('refuses a topic from another skill, a missing reason, duplicates and nonsense', async () => {
    expect((await runTool('set_next_focus', { picks: [{ skill: 'admittance', topic: 'gamma_vswr', why: 'x' }] }, ctx)).content).toMatch(/not part of admittance. Its topics: plot_y, read_y/)
    expect((await runTool('set_next_focus', { picks: [{ skill: 'admittance', why: ' ' }] }, ctx)).content).toMatch(/short "why"/)
    expect((await runTool('set_next_focus', { picks: [{ skill: 'admittance', why: 'a' }, { skill: 'admittance', why: 'b' }] }, ctx)).content).toMatch(/Each skill once/)
    expect((await runTool('set_next_focus', { picks: [{ skill: 'smith_wizardry', why: 'a' }] }, ctx)).content).toMatch(/Unknown skill/)
    expect((await runTool('set_next_focus', { picks: [] }, ctx)).content).toMatch(/Give 1–3 picks/)
  })

  it('keeps at most three, and the profile tool reports the plan and the standing', async () => {
    await runTool('set_next_focus', { picks: ['chart_basics', 'reflection', 'admittance', 'tlines'].map((skill) => ({ skill, why: 'w' })) }, ctx)
    expect(profile.nextFocus!.picks).toHaveLength(3)
    const r = JSON.parse((await runTool('get_learner_profile', {}, ctx)).content)
    expect(r.next_focus.picks).toHaveLength(3)
    expect(r.standing).toMatch(/^Standing \(targets: strong 75%/)
    expect(r.recommended_focus).toBeUndefined()
  })
})
