import { describe, expect, it } from 'vitest'
import { createProfile, migrateProfile, type AnswerRecord, type Profile, type SkillId } from './profile'
import { learnerBrief, recordGraded, type GradedMeta } from './memory'
import { checkValues, moveReading, readingBrief, readingLine, readingOf, readingStart, type ReadingState, type ValuesSeen } from './reading'

const AT = '2026-10-09T12:00:00.000Z'
const fresh = (): Profile => migrateProfile(createProfile('Riya', { experience: 'new' }))
const on = (p: Profile, skill: SkillId, stage: ReadingState['stage'], extra: Partial<ReadingState> = {}): Profile =>
  ({ ...p, reading: { ...(p.reading ?? {}), [skill]: { stage, streak: 0, misses: 0, source: 'answers', at: AT, ...extra } } })
const withMastery = (p: Profile, skill: SkillId, mastery: number): Profile => ({ ...p, skills: { ...p.skills, [skill]: { ...p.skills[skill], mastery } } })
const VSWR: GradedMeta = { topic: 'gamma_vswr', skill: 'reflection', difficulty: 1 }
const record = (p: Profile, outcome: 'correct' | 'partial' | 'incorrect', values?: ValuesSeen, sure?: 'sure' | 'unsure' | 'guess') =>
  recordGraded(p, { meta: VSWR, outcome, label: 'VSWR of the load', session: 'L1', at: AT, format: 'value', values, sure })
/** Apply one answer's move, as recordGraded does. */
const step = (p: Profile, values: ValuesSeen, right: boolean, sure?: 'sure' | 'unsure' | 'guess', skill: SkillId = 'reflection', helped = false): Profile => {
  const mv = moveReading(p, skill, values, right ? 'correct' : 'incorrect', { sure, helped }, AT)
  return { ...p, reading: { ...(p.reading ?? {}), [skill]: mv.state } }
}

describe('where a skill starts: the readout for a beginner, the chart for someone who knows it', () => {
  it('a new learner starts on the readout, as an estimate', () => {
    expect(readingOf(fresh(), 'chart_basics')).toMatchObject({ stage: 'readout', provisional: true, source: 'start' })
  })

  it('mastery from the placement test or earlier work starts them on the chart', () => {
    expect(readingStart(withMastery(fresh(), 'reflection', 0.5), 'reflection', AT)).toMatchObject({ stage: 'chart', provisional: true, source: 'start' })
    expect(readingStart(withMastery(fresh(), 'reflection', 0.3), 'reflection', AT).stage).toBe('readout')
  })

  it('reading chart basics from the chart carries over to the skills that build on it, but not an estimate', () => {
    expect(readingOf(on(fresh(), 'chart_basics', 'chart'), 'reflection')).toMatchObject({ stage: 'chart', source: 'related', provisional: true })
    expect(readingOf(on(fresh(), 'chart_basics', 'chart', { provisional: true, source: 'start' }), 'reflection').stage).toBe('readout')
    // tlines builds on reflection: that carries over too.
    expect(readingOf(on(fresh(), 'reflection', 'chart'), 'tlines').stage).toBe('chart')
  })
})

describe('moving between the readout and the chart, both ways', () => {
  it('one clean answer from the chart moves a beginner to the chart', () => {
    const p = step(fresh(), 'covered', true, 'sure')
    expect(p.reading!.reflection).toMatchObject({ stage: 'chart', provisional: false, source: 'answers' })
  })

  it('right answers with the values shown move them to the chart at their pace (two by default)', () => {
    let p = step(fresh(), 'shown', true, 'sure')
    expect(p.reading!.reflection).toMatchObject({ stage: 'readout', streak: 1 })
    p = step(p, 'shown', true, 'unsure') // right but unsure: half
    expect(p.reading!.reflection).toMatchObject({ stage: 'readout', streak: 1.5 })
    p = step(step(p, 'shown', true), 'shown', true)
    expect(p.reading!.reflection!.stage).toBe('chart')
    // A quick climber (their ladder pace) needs one.
    const quick = step({ ...fresh(), ladderPace: [1, 1, 1] }, 'shown', true)
    expect(quick.reading!.reflection!.stage).toBe('chart')
  })

  it('a lucky guess, a wrong copy or a right answer after help never moves them on', () => {
    expect(step(fresh(), 'shown', true, 'guess').reading!.reflection).toMatchObject({ stage: 'readout', streak: 0 })
    expect(step(fresh(), 'covered', true, 'sure', 'reflection', true).reading!.reflection).toMatchObject({ stage: 'readout', streak: 0 })
    expect(step(fresh(), 'covered', true, 'unsure').reading!.reflection!.stage).toBe('readout')
    expect(step(fresh(), 'shown', false, 'sure').reading!.reflection).toMatchObject({ stage: 'readout', streak: 0 })
  })

  it('from the chart: a sure miss takes them back to the readout, an unsure one needs two', () => {
    const p = on(fresh(), 'reflection', 'chart')
    expect(step(p, 'covered', false, 'sure').reading!.reflection!.stage).toBe('readout')
    const once = step(p, 'covered', false, 'unsure')
    expect(once.reading!.reflection).toMatchObject({ stage: 'chart', misses: 1 })
    expect(step(once, 'covered', false, 'unsure').reading!.reflection!.stage).toBe('readout')
    // A wrong guess shows a gap, not a slip in reading: no move.
    expect(step(p, 'covered', false, 'guess').reading!.reflection).toMatchObject({ stage: 'chart', misses: 0 })
  })

  it('an estimate on the chart drops on the first miss; one earned from answers holds', () => {
    const est = { stage: 'chart' as const, provisional: true, source: 'start' as const }
    expect(step(on(fresh(), 'reflection', 'chart', est), 'covered', false, 'unsure').reading!.reflection!.stage).toBe('readout')
    expect(step(on(fresh(), 'reflection', 'chart'), 'covered', false, 'unsure').reading!.reflection!.stage).toBe('chart')
  })

  it('uncovering the values twice in a row takes them back to the readout, whatever they answered', () => {
    const p = on(fresh(), 'reflection', 'chart')
    const once = step(p, 'revealed', true, 'sure')
    expect(once.reading!.reflection).toMatchObject({ stage: 'chart', misses: 1 })
    expect(step(once, 'revealed', true, 'sure').reading!.reflection!.stage).toBe('readout')
    // A clean answer from the chart in between resets the count.
    expect(step(step(once, 'covered', true, 'sure'), 'revealed', true).reading!.reflection!.stage).toBe('chart')
  })

  it('values shown by the tutor as a warm-up on the chart stage show nothing about reading', () => {
    const p = on(fresh(), 'reflection', 'chart', { streak: 2 })
    expect(step(p, 'shown', true, 'sure').reading!.reflection).toMatchObject({ stage: 'chart', streak: 2 })
  })
})

describe('fixes from the review', () => {
  it('misses count in a row: a right answer in between (even unsure) resets them', () => {
    let p = on(fresh(), 'reflection', 'chart')
    p = step(p, 'covered', false, 'unsure')
    p = step(p, 'covered', true, 'unsure')
    expect(p.reading!.reflection).toMatchObject({ stage: 'chart', misses: 0 })
    p = step(p, 'covered', false, 'unsure')
    expect(p.reading!.reflection).toMatchObject({ stage: 'chart', misses: 1 })
  })

  it('an estimate nobody has confirmed follows their mastery as it grows', () => {
    // A right-but-unsure answer on the readout saves the estimate without confirming it.
    let p = step(fresh(), 'shown', true, 'unsure')
    expect(p.reading!.reflection).toMatchObject({ stage: 'readout', provisional: true })
    p = withMastery(p, 'reflection', 0.5)
    expect(readingOf(p, 'reflection')).toMatchObject({ stage: 'chart', provisional: true })
    // Once confirmed by an answer, it stays where the answers put it.
    const confirmed = on(withMastery(fresh(), 'reflection', 0.6), 'reflection', 'readout')
    expect(readingOf(confirmed, 'reflection').stage).toBe('readout')
  })

  it('a typed point (the keyboard way) counts partly and moves nothing, either way', () => {
    expect(step(fresh(), 'typed', true, 'sure').reading!.reflection).toMatchObject({ stage: 'readout', streak: 0 })
    expect(step(on(fresh(), 'reflection', 'chart'), 'typed', false, 'sure').reading!.reflection).toMatchObject({ stage: 'chart', misses: 0 })
    const r = record(fresh(), 'correct', 'typed', 'sure')
    expect(r.report).toMatch(/counted as partly right: they typed the point instead of finding it on the chart/)
    expect(r.profile.skills.reflection.mastery).toBeLessThan(record(fresh(), 'correct', 'covered', 'sure').profile.skills.reflection.mastery)
  })

  it('uncovering values the tutor covered as a stretch, on the readout stage, counts as reading them off the readout', () => {
    const p = step(fresh(), 'revealed', true, 'sure')
    expect(p.reading!.reflection).toMatchObject({ stage: 'readout', streak: 1 })
  })
})

describe('covering the values: the app decides, the tutor can stretch or ask with a reason', () => {
  it('readout stage: shown by default, covered on request as a stretch', () => {
    expect(checkValues(fresh(), 'reflection', undefined)).toMatchObject({ ok: true, values: 'shown' })
    expect(checkValues(fresh(), 'reflection', 'covered')).toMatchObject({ ok: true, values: 'covered' })
    expect(checkValues(fresh(), 'reflection', 'covered').message).toMatch(/a stretch/)
  })

  it('chart stage: covered by default; showing them is refused without a reason', () => {
    const p = on(fresh(), 'reflection', 'chart')
    expect(checkValues(p, 'reflection', undefined)).toMatchObject({ ok: true, values: 'covered' })
    expect(checkValues(p, 'reflection', 'covered')).toMatchObject({ ok: true, values: 'covered' })
    const r = checkValues(p, 'reflection', 'shown')
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/They read reflection from the chart, so the app covers the values\. .*rung_reason/)
  })

  it('a reason shows them, within the lesson allowance; after_miss needs a miss', () => {
    const p = on(fresh(), 'reflection', 'chart')
    expect(checkValues(p, 'reflection', 'shown', { reason: 'warm_up' })).toMatchObject({ ok: true, values: 'shown', override: 'warm_up' })
    expect(checkValues(p, 'reflection', 'shown', { reason: 'warm_up', used: [{ reason: 'warm_up' }] }).message).toMatch(/already used 1× this lesson/)
    const answered = (outcome: AnswerRecord['outcome']): Profile => ({ ...p, answers: [{ at: AT, session: 'L1', topic: 'gamma_vswr', skill: 'reflection', difficulty: 1, outcome }] })
    expect(checkValues(answered('correct'), 'reflection', 'shown', { reason: 'after_miss' }).message).toMatch(/wasn't a miss/)
    expect(checkValues(answered('incorrect'), 'reflection', 'shown', { reason: 'after_miss' })).toMatchObject({ ok: true, values: 'shown' })
  })
})

describe('what an answer counts for', () => {
  it('right with the values on screen counts partly, and says why', () => {
    const shown = record(fresh(), 'correct', 'shown', 'sure')
    const covered = record(fresh(), 'correct', 'covered', 'sure')
    expect(shown.profile.skills.reflection.mastery).toBeLessThan(covered.profile.skills.reflection.mastery)
    expect(shown.report).toMatch(/counted as partly right: the values were on their screen/)
    expect(record(fresh(), 'correct', 'revealed', 'sure').report).toMatch(/the values were on their screen \(they uncovered them\)/)
    expect(covered.report).not.toMatch(/partly right/)
  })

  it('right from the chart counts the same as before the change (a question without values is unaffected)', () => {
    expect(record(fresh(), 'correct', 'covered', 'sure').profile.skills.reflection.mastery).toBe(record(fresh(), 'correct', undefined, 'sure').profile.skills.reflection.mastery)
    expect(record(fresh(), 'correct', undefined, 'sure').profile.reading).toBeUndefined()
  })

  it('keeps the stage and the record, and tells the tutor when the stage changes', () => {
    const r = record(fresh(), 'correct', 'covered', 'sure')
    expect(r.profile.reading!.reflection).toMatchObject({ stage: 'chart', provisional: false })
    expect(r.profile.answers!.at(-1)).toMatchObject({ values: 'covered', outcome: 'correct' })
    expect(r.report).toMatch(/reading: reflection read it from the chart cleanly: values stay covered from now on/)
    // Saved and loaded again: the stage is still there.
    expect(migrateProfile(JSON.parse(JSON.stringify(r.profile))).reading!.reflection!.stage).toBe('chart')
  })
})

describe('words for the tutor and the learner', () => {
  it('the brief lists the skills by stage, estimates marked', () => {
    const p = on(withMastery(fresh(), 'tlines', 0.6), 'reflection', 'chart')
    const line = readingBrief(p)
    expect(line).toMatch(/from the chart, values covered: reflection, tlines\?; off the readout, values shown: chart_basics\?, admittance\?, q_bandwidth\?/)
    expect(learnerBrief(p, AT).text).toContain(line)
  })

  it('the Progress line shows for the reading skills only (the others have their ladder rung)', () => {
    expect(readingLine(fresh(), 'admittance')).toMatchObject({ now: 'reading values off the readout', provisional: true })
    expect(readingLine(on(fresh(), 'admittance', 'chart'), 'admittance')).toMatchObject({ now: 'reading values from the chart yourself', provisional: false })
    expect(readingLine(fresh(), 'tlines')).toBeNull()
    expect(readingLine(fresh(), 'sweep_reading')).toBeNull()
  })
})
