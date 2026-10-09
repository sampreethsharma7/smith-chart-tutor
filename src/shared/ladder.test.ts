import { describe, expect, it } from 'vitest'
import { createProfile, migrateProfile, type AnswerRecord, type Profile } from './profile'
import { learnerBrief, recordGraded, type GradedMeta } from './memory'
import {
  checkRung, climbAfter, ladderBrief, ladderLine, ladderOf, moveOnLadder, namedParts, rebuildLadder, rungOfMatch,
  rungOfMove, rungOfReach, startRung, type LadderState, type Rung
} from './ladder'

const AT = '2026-10-09T12:00:00.000Z'
const fresh = (): Profile => migrateProfile(createProfile('Riya', { experience: 'new' }))
const at = (p: Profile, skill: 'lumped_moves' | 'l_match' | 'tlines' | 'stubs', rung: Rung, extra: Partial<LadderState> = {}): Profile =>
  ({ ...p, ladder: { ...(p.ladder ?? {}), [skill]: { rung, streak: 0, misses: 0, tries: 0, source: 'answers', at: AT, ...extra } } })
const item = (rung: Rung, skill: GradedMeta['skill'] = 'l_match', topic: GradedMeta['topic'] = 'l_match'): GradedMeta => ({ topic, skill, difficulty: 2, rung })
const step = (p: Profile, m: GradedMeta, outcome: 'correct' | 'partial' | 'incorrect', sure?: 'sure' | 'unsure' | 'guess') =>
  moveOnLadder(p, m, outcome, sure, outcome === 'correct' && sure === 'unsure', AT)!
/** Apply a move to the profile, as recordGraded does. */
const apply = (p: Profile, m: GradedMeta, outcome: 'correct' | 'partial' | 'incorrect', sure?: 'sure' | 'unsure' | 'guess'): Profile => {
  const mv = step(p, m, outcome, sure)
  return { ...p, ladder: { ...p.ladder, [m.skill]: mv.state }, ...(mv.pace !== undefined ? { ladderPace: [...(p.ladderPace ?? []), mv.pace] } : {}) }
}

describe('what an item asks of the learner (the app decides, from how it was set up)', () => {
  it('spots parts named in the instructions, but not a choice between parts', () => {
    expect(namedParts('Add a shunt capacitor to move the point onto r = 1.')).toEqual(['shuntC'])
    expect(namedParts('Use a series inductor, then a shunt cap.')).toEqual(['seriesL', 'shuntC'])
    expect(namedParts('Add a parallel capacitor across the load')).toEqual(['shuntC'])
    // The other word order, and parts by number.
    expect(namedParts('Add an inductor in series with the load')).toEqual(['seriesL'])
    expect(namedParts('Add series inductance')).toEqual(['seriesL'])
    expect(namedParts('Put C1 in shunt')).toEqual(['shuntC'])
    // Not asked for: a part already there, or one they mustn't use.
    expect(namedParts('Your series L got you to g = 1. Now finish the match.')).toEqual([])
    expect(namedParts("Don't use a shunt C here.")).toEqual([])
    expect(namedParts('Match it without a series capacitor.')).toEqual([])
    // A choice only drops the parts in the choice.
    expect(namedParts('Use a shunt C to reach g = 1, then pick a series L or C')).toEqual(['shuntC'])
    // Stub types give nothing away (where it goes and how long are still theirs).
    expect(namedParts('Tune a shorted stub of about 45°')).toEqual([])
    expect(namedParts('Add an open stub')).toEqual([])
    // From the novice test: these offer a choice.
    expect(namedParts('Add ONE shunt part (L or C) across the load so the point lands on the r = 1 circle.')).toEqual([])
    expect(namedParts('Use a shunt L or C')).toEqual([])
    expect(namedParts('a series inductor or capacitor, your call')).toEqual([])
    expect(namedParts('Use an open or short stub')).toEqual([])
    expect(namedParts('Match the load to VSWR ≤ 1.5 with any two parts.')).toEqual([])
  })

  it('rates one-step tasks, full matches and questions', () => {
    // A single allowed part, or the part named: guided. Otherwise the part is theirs to choose.
    expect(rungOfReach(['shuntC'], 'Get onto r = 1')).toBe(1)
    expect(rungOfReach(undefined, 'Add a shunt capacitor until you reach r = 1')).toBe(1)
    expect(rungOfReach(['shuntL', 'shuntC'], 'Use one shunt part to reach r = 1')).toBe(2)
    expect(rungOfReach(undefined, 'Get the point onto the g = 1 circle')).toBe(2)
    // A full match: named parts leave only the values; else the plan is theirs; limits make it constrained.
    expect(rungOfMatch(['shuntL', 'seriesC'], 1.5, false, 'Build it with a shunt L then a series C')).toBe(2)
    expect(rungOfMatch(undefined, 1.5, false, 'Match this load to VSWR ≤ 1.5')).toBe(3)
    expect(rungOfMatch(undefined, 1.5, true, 'Match it across 2.4–2.5 GHz')).toBe(4)
    expect(rungOfMatch(undefined, 1.15, false, 'Match it tightly')).toBe(4)
    // Only the solution's two parts allowed: the card offers just those, so that's guidance, not a constraint.
    expect(rungOfMatch(['seriesL', 'shuntC'], 1.5, false, 'Match it with the parts offered')).toBe(2)
    // Ruling out one kind of part is a constraint.
    expect(rungOfMatch(['seriesL', 'seriesC', 'shuntC'], 1.5, false, 'Match it, no shunt inductors')).toBe(4)
    // Lines and stubs are what a line or stub match is made of, not a restriction.
    expect(rungOfMatch(['tline'], 1.5, false, 'Match it with lines only')).toBe(3)
    expect(rungOfMatch(['tline', 'openStub'], 1.5, false, 'Match with a single stub')).toBe(3)
    expect(rungOfMatch(['tline', 'shortStub'], 1.5, true, 'Match with a stub across the band')).toBe(4)
    expect(rungOfMove(false)).toBe(1)
    expect(rungOfMove(true)).toBe(2)
  })
})

describe('where a skill starts', () => {
  it('a new learner starts at rung 1, provisionally', () => {
    expect(startRung(fresh(), 'l_match')).toMatchObject({ rung: 1, provisional: true })
  })

  it('a related skill gives a head start: one rung below the confirmed prerequisite', () => {
    const p = at(fresh(), 'lumped_moves', 3)
    expect(startRung(p, 'l_match')).toMatchObject({ rung: 2, provisional: true, source: 'related' })
    // Only confirmed rungs carry over; an estimate isn't evidence.
    expect(startRung(at(fresh(), 'lumped_moves', 3, { provisional: true }), 'l_match').rung).toBe(1)
    // Stubs build on lines: lines at 4 → stubs at 3.
    expect(startRung(at(fresh(), 'tlines', 4), 'stubs').rung).toBe(3)
  })

  it('or from the skill\'s own mastery, whichever is higher', () => {
    const p = fresh()
    const strong = { ...p, skills: { ...p.skills, l_match: { ...p.skills.l_match, mastery: 0.75 } } }
    expect(startRung(strong, 'l_match')).toMatchObject({ rung: 3, provisional: true, source: 'start' })
  })
})

describe('moving on the ladder: both ways, at this learner\'s pace', () => {
  it('goes up after two clean answers at the rung by default', () => {
    let p = at(fresh(), 'l_match', 2)
    p = apply(p, item(2), 'correct', 'sure')
    expect(ladderOf(p, 'l_match')).toMatchObject({ rung: 2, streak: 1 })
    const up = step(p, item(2), 'correct', 'sure')
    expect(up.state).toMatchObject({ rung: 3, streak: 0 })
    expect(up.note).toMatch(/up: rung 2 \(one choice\) → rung 3 \(unguided\)/)
    expect(up.pace).toBe(2) // the climb took two answers
  })

  it('a fast climber goes up after one; a slow one needs three', () => {
    expect(climbAfter(fresh())).toBe(2)
    expect(climbAfter({ ...fresh(), ladderPace: [1, 1, 2] })).toBe(1)
    expect(climbAfter({ ...fresh(), ladderPace: [3, 4, 5] })).toBe(3)
    const fast = at({ ...fresh(), ladderPace: [1, 1, 2] }, 'l_match', 2)
    expect(step(fast, item(2), 'correct', 'sure').state.rung).toBe(3)
  })

  it('stays when right but unsure, helped or partly right', () => {
    const p = at(fresh(), 'l_match', 2, { streak: 1 })
    expect(step(p, item(2), 'correct', 'unsure').state).toMatchObject({ rung: 2, streak: 1 }) // neither proof nor a miss
    expect(step(p, item(2), 'partial', 'sure').state).toMatchObject({ rung: 2, streak: 0 }) // help or a guess makes it partial
  })

  it('steps down on a sure miss, or on the second miss in a row', () => {
    const p = at(fresh(), 'l_match', 3, { streak: 1 })
    const sure = step(p, item(3), 'incorrect', 'sure')
    expect(sure.state.rung).toBe(2)
    expect(sure.note).toMatch(/down: rung 3 \(unguided\) → rung 2/)
    const once = apply(p, item(3), 'incorrect', 'unsure')
    expect(ladderOf(once, 'l_match')).toMatchObject({ rung: 3, misses: 1, streak: 0 })
    expect(step(once, item(3), 'incorrect', 'unsure').state.rung).toBe(2)
    // A right answer in between resets the count.
    const between = apply(once, item(3), 'correct', 'sure')
    expect(step(between, item(3), 'incorrect', 'unsure').state.rung).toBe(3)
  })

  it('a wrong guess is a gap, not a reason to step down', () => {
    const p = at(fresh(), 'l_match', 3, { streak: 1 })
    expect(step(p, item(3), 'incorrect', 'guess').state).toMatchObject({ rung: 3, streak: 0, misses: 0 })
  })

  it('a clean pass on a harder item moves them up one step, however hard it was; a miss on one is expected', () => {
    const p = at(fresh(), 'l_match', 2)
    const jump = step(p, item(4), 'correct', 'sure')
    expect(jump.state.rung).toBe(3)
    expect(jump.note).toMatch(/passed a harder item cleanly: rung 2 \(one choice\) → rung 3 \(unguided\)/)
    expect(jump.pace).toBeUndefined() // one answer isn't a measure of how long climbing takes
    expect(step(p, item(4), 'incorrect', 'sure').state).toMatchObject({ rung: 2, misses: 0 })
    // From the review: one spot-the-mistake pick no longer takes a beginner straight to judge.
    const beginner = at(fresh(), 'lumped_moves', 1, { provisional: true, source: 'start' })
    expect(step(beginner, item(5, 'lumped_moves', 'dir_shuntC'), 'correct', 'sure').state.rung).toBe(2)
  })

  it('an easy item done well changes nothing (the streak is kept)', () => {
    const p = at(fresh(), 'l_match', 3, { streak: 1 })
    expect(step(p, item(1), 'correct', 'sure').state).toMatchObject({ rung: 3, streak: 1 })
  })

  it('an estimate is confirmed by a clean answer, and dropped fast by a miss', () => {
    const p = at(fresh(), 'l_match', 2, { provisional: true, source: 'related' })
    expect(step(p, item(2), 'correct', 'sure').state).toMatchObject({ rung: 2, provisional: false, source: 'answers' })
    expect(step(p, item(2), 'incorrect', 'unsure').state).toMatchObject({ rung: 1, provisional: false })
    // A rung rebuilt from their own answers is held like a confirmed one: one unsure miss doesn't drop it.
    const fromHistory = at(fresh(), 'l_match', 3, { provisional: true, source: 'history' })
    expect(step(fromHistory, item(3), 'incorrect', 'unsure').state).toMatchObject({ rung: 3, misses: 1 })
  })

  it('never goes below 1 or above 5', () => {
    expect(step(at(fresh(), 'l_match', 1), item(1), 'incorrect', 'sure').state.rung).toBe(1)
    expect(step(at(fresh(), 'l_match', 5, { streak: 1 }), item(5), 'correct', 'sure').state.rung).toBe(5)
    // Constrained matches don't streak into judging either.
    expect(step(at(fresh(), 'l_match', 4, { streak: 2 }), item(4), 'correct', 'sure').state).toMatchObject({ rung: 4, streak: 3 })
  })

  it('reading items and skills off the ladder are left alone', () => {
    const p = fresh()
    expect(moveOnLadder(p, { topic: 'gamma_vswr', skill: 'reflection', difficulty: 1 }, 'correct', 'sure', false, AT)).toBeNull()
    expect(moveOnLadder(p, { topic: 'wtg', skill: 'tlines', difficulty: 2 }, 'correct', 'sure', false, AT)).toBeNull()
  })
})

describe('holding the tutor to the rung', () => {
  const p = at(fresh(), 'l_match', 3)
  const reach = (rung: Rung) => item(rung)

  it('allows the rung, one below (a warm-up) and anything above (a stretch)', () => {
    expect(checkRung(p, reach(3))).toMatchObject({ ok: true })
    expect(checkRung(p, reach(2)).message).toMatch(/one step below, fine as a warm-up/)
    expect(checkRung(p, reach(5)).message).toMatch(/a stretch, so expect to support them/)
  })

  it('refuses two below, and says how to pitch it at their rung', () => {
    const r = checkRung(p, reach(1))
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/Too easy for them: this item is rung 1 \(guided\), and they're l_match at rung 3 \(unguided\)/)
    expect(r.message).toMatch(/give a load and a goal .*don't name the parts/)
    expect(r.message).toMatch(/rung_reason: "warm_up"/)
  })

  it('a reason lets it through, within the lesson\'s allowance', () => {
    expect(checkRung(p, reach(1), { reason: 'warm_up' })).toMatchObject({ ok: true, override: 'warm_up' })
    const used = [{ reason: 'warm_up' }]
    expect(checkRung(p, reach(1), { reason: 'warm_up', used })).toMatchObject({ ok: false })
    expect(checkRung(p, reach(1), { reason: 'learner_asked', used: [...used, { reason: 'learner_asked' }] })).toMatchObject({ ok: true })
    expect(checkRung(p, reach(1), { reason: 'learner_asked', used: [{ reason: 'learner_asked' }, { reason: 'learner_asked' }] }).ok).toBe(false)
    expect(checkRung(p, reach(1), { reason: 'made_up' }).ok).toBe(false)
  })

  it('after_miss only counts right after a miss on that skill', () => {
    const answered = (outcome: 'correct' | 'incorrect'): Profile => ({ ...p, answers: [{ at: AT, session: 's', topic: 'l_match', skill: 'l_match', difficulty: 2, outcome } as AnswerRecord] })
    expect(checkRung(answered('incorrect'), reach(1), { reason: 'after_miss' }).ok).toBe(true)
    const after = checkRung(answered('correct'), reach(1), { reason: 'after_miss' })
    expect(after.ok).toBe(false)
    expect(after.message).toMatch(/their last answer on this skill wasn't a miss/)
    // From the review: no answers at all, or a partly right one, isn't a miss either.
    expect(checkRung(p, reach(1), { reason: 'after_miss' }).ok).toBe(false)
    expect(checkRung({ ...p, answers: [{ ...answered('correct').answers![0], outcome: 'partial' }] }, reach(1), { reason: 'after_miss' }).ok).toBe(false)
  })

  it('counts steps on the skill\'s own ladder: single moves go guided, one choice, then judge', () => {
    // Series/shunt moves have no unguided or constrained items, so after one choice comes judging a worked match.
    let q = at(fresh(), 'lumped_moves', 2, { streak: 1 })
    const move = (rung: Rung) => item(rung, 'lumped_moves', 'dir_shuntC')
    // A streak of one-choice items doesn't make them a judge: that is earned only by passing a judge item.
    expect(step(q, move(2), 'correct', 'sure').state).toMatchObject({ rung: 2, streak: 2 })
    const up = step(q, move(5), 'correct', 'sure')
    expect(up.state.rung).toBe(5)
    expect(up.note).toMatch(/passed a harder item cleanly: rung 2 \(one choice\) → rung 5 \(judge\)/)
    q = { ...q, ladder: { lumped_moves: up.state } }
    // At judge, a one-choice item is one step below (fine); a guided one is two (refused).
    expect(checkRung(q, move(2)).ok).toBe(true)
    expect(checkRung(q, move(1)).ok).toBe(false)
    // A sure miss steps back to one choice, not to a rung the skill doesn't have.
    expect(step(q, move(5), 'incorrect', 'sure').state.rung).toBe(2)
  })

  it('an estimate never starts past unguided, and only on rungs the skill has', () => {
    const p0 = fresh()
    const keen = { ...at(p0, 'l_match', 5), skills: { ...p0.skills, q_bandwidth: { ...p0.skills.q_bandwidth, mastery: 0.9 } } }
    // From l_match at judge it would be 4; capped at 3, and Q & bandwidth has no 3 (a band match is constrained): 2.
    expect(startRung(keen, 'q_bandwidth').rung).toBe(2)
  })

  it('an estimate is held more loosely: two steps below is still allowed, three is not', () => {
    const est = at(fresh(), 'l_match', 3, { provisional: true, source: 'start' }) // e.g. an "advanced" newcomer
    expect(checkRung(est, item(1)).ok).toBe(true)
    expect(checkRung(est, item(1)).message).toMatch(/provisionally at rung 3 \(unguided\), an estimate/)
    expect(checkRung(at(fresh(), 'l_match', 4, { provisional: true }), item(1)).ok).toBe(false)
  })

  it('reading items have no rung and are never refused', () => {
    expect(checkRung(p, { topic: 'plot_z', skill: 'chart_basics', difficulty: 1 })).toEqual({ ok: true, message: '' })
  })
})

describe('kept in the profile', () => {
  it('a graded answer moves the rung, records it with the answer and tells the tutor', () => {
    let p = at(fresh(), 'l_match', 2, { streak: 1 })
    const r = recordGraded(p, { meta: { ...item(2), ctx: 'lower half, one frequency' }, outcome: 'correct', sure: 'sure', label: 'Match it', session: 's1', at: AT, format: 'task' })
    p = r.profile
    expect(p.ladder!.l_match).toMatchObject({ rung: 3 })
    expect(p.answers!.at(-1)).toMatchObject({ rung: 2, outcome: 'correct' })
    expect(p.ladderPace).toEqual([1])
    expect(r.report).toMatch(/independence ladder: l_match up: rung 2 \(one choice\) → rung 3 \(unguided\)/)
  })

  it('help on a right answer holds the rung', () => {
    const p = at(fresh(), 'l_match', 2, { streak: 1 })
    const r = recordGraded(p, { meta: item(2), outcome: 'correct', sure: 'sure', helped: true, label: 'x', session: 's1', at: AT })
    expect(r.profile.ladder!.l_match).toMatchObject({ rung: 2, streak: 0 })
  })

  it('survives saving and reopening the app', () => {
    const p = recordGraded(at(fresh(), 'tlines', 3), { meta: item(3, 'tlines', 'reach_line'), outcome: 'correct', sure: 'sure', label: 'x', session: 's1', at: AT }).profile
    const reopened = migrateProfile(JSON.parse(JSON.stringify(p)))
    expect(reopened.ladder).toEqual(p.ladder)
    expect(reopened.ladderPace).toEqual(p.ladderPace)
  })

  it('a learner from before the ladder gets rungs from their saved answers, provisionally, once', () => {
    const a = (topic: AnswerRecord['topic'], skill: AnswerRecord['skill'], format: string, outcome: AnswerRecord['outcome'], i: number, extra: Partial<AnswerRecord> = {}): AnswerRecord =>
      ({ at: `2026-10-0${1 + Math.floor(i / 5)}T10:0${i % 5}:00.000Z`, session: 's', topic, skill, difficulty: 2, outcome, sure: 'sure', format, ...extra })
    const answers: AnswerRecord[] = [
      // Direction questions (guided), then full matches done on their own: up to unguided and beyond.
      a('dir_shuntC', 'lumped_moves', 'mcq', 'correct', 0),
      a('dir_shuntC', 'lumped_moves', 'mcq', 'correct', 1),
      a('l_match', 'l_match', 'task', 'correct', 2),
      a('l_match', 'l_match', 'task', 'correct', 3),
      a('l_match', 'l_match', 'task', 'correct', 4),
      // Reading answers don't touch the ladder.
      a('gamma_vswr', 'reflection', 'value', 'correct', 5)
    ]
    const old = { ...createProfile('Old'), answers } as Profile
    delete (old as Partial<Profile>).ladder
    const p = migrateProfile(old)
    expect(p.ladder!.lumped_moves).toMatchObject({ rung: 2, provisional: true, source: 'history' })
    expect(p.ladder!.l_match).toMatchObject({ provisional: true, source: 'history' })
    expect(p.ladder!.l_match!.rung).toBeGreaterThanOrEqual(3)
    expect(p.ladder!.reflection).toBeUndefined()
    // Already has a ladder: left as it is.
    const again = migrateProfile({ ...p, ladder: { l_match: { rung: 1, streak: 0, misses: 0, tries: 0, source: 'answers', at: AT } } })
    expect(again.ladder!.l_match!.rung).toBe(1)
    // Rebuilding is a pure replay: the same answers give the same rungs.
    expect(rebuildLadder(old).ladder).toEqual(rebuildLadder(old).ladder)
  })
})

describe('words for the tutor and the learner', () => {
  it('the brief tells the tutor each ladder skill\'s rung and how to pitch it', () => {
    const p = at(fresh(), 'l_match', 3)
    const b = learnerBrief(p, AT).text
    expect(b).toMatch(/Independence ladder \(how much they decide; app-enforced/)
    expect(b).toMatch(/- l_match: rung 3 unguided: give a load and a goal; don't name the parts/)
    expect(b).toMatch(/- stubs: rung 1 guided \(provisional\)/)
    expect(b).not.toMatch(/- chart_basics: rung/)
  })

  it('says when they come back after a break', () => {
    const p = at(fresh(), 'l_match', 3)
    const away = { ...p, skills: { ...p.skills, l_match: { ...p.skills.l_match, lastPracticed: '2026-09-01T00:00:00.000Z' } } }
    expect(ladderBrief(away, AT)).toMatch(/l_match: rung 3 unguided: .*back after a break: a warm-up one rung lower is fine/)
  })

  it('the Progress page says it in plain words, with the next step', () => {
    const p = at(fresh(), 'l_match', 3)
    // What they're working at now, not a claim of mastery; the next step is on the skill's own rungs.
    expect(ladderLine(p, 'l_match')).toEqual({ now: 'planning whole matches yourself', next: 'matching under limits (bands, tight targets, fewer parts)', provisional: false })
    expect(ladderLine(at(fresh(), 'lumped_moves', 2), 'lumped_moves')).toMatchObject({ now: 'choosing the part yourself', next: 'checking worked solutions for mistakes' })
    expect(ladderLine(at(fresh(), 'tlines', 4), 'tlines')).toMatchObject({ next: undefined })
    expect(ladderLine(p, 'reflection')).toBeNull()
    expect(ladderLine(fresh(), 'stubs')).toBeNull() // nothing shown until there's a rung to show
  })
})
