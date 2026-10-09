import { describe, expect, it } from 'vitest'
import { ANSWER_LOG_MAX, createProfile, exportProfile, migrateProfile, resetProgress, type Profile } from './profile'
import {
  aimFor, classifyLocate, classifyMatch, classifyMove, classifyReach, classifyValue, forgetNote, learnerBrief, misconceptionSignOff,
  inferTopic, noteAsked, NOTES_PER_CATEGORY, recordGraded, REVIEW_DAYS, saveNote, startLevel, topicDef, type GradedMeta, type TopicId
} from './memory'

const T0 = '2026-10-07T10:00:00.000Z'
const at = (days: number, mins = 0) => new Date(new Date(T0).getTime() + days * 86_400_000 + mins * 60_000).toISOString()

function learner(experience: Profile['background']['experience'] = 'basics'): Profile {
  return migrateProfile(createProfile('Sam', { experience }))
}

function answer(p: Profile, m: GradedMeta, ok: boolean | 'partial', session: string, when: string, misconception?: string) {
  return recordGraded(p, { meta: m, outcome: ok === 'partial' ? 'partial' : ok ? 'correct' : 'incorrect', label: m.topic, session, at: when, misconception })
}

describe('what each graded item practises, and how hard it is (decided by the app)', () => {
  it('maps every tool to a specific topic', () => {
    expect(classifyMove('shuntC', 'path')).toEqual({ topic: 'dir_shuntC', skill: 'lumped_moves', difficulty: 1 })
    expect(classifyMove('seriesC', 'end_half')).toMatchObject({ topic: 'land_lumped', difficulty: 2 })
    expect(classifyMove('tline', 'path')).toMatchObject({ topic: 'dir_line', skill: 'tlines' })
    expect(classifyLocate('z', true)).toMatchObject({ topic: 'plot_z', difficulty: 1 })
    expect(classifyLocate('z', false).difficulty).toBe(2)
    expect(classifyLocate('y')).toMatchObject({ topic: 'plot_y', skill: 'admittance' })
    expect(classifyLocate('tline')).toMatchObject({ topic: 'land_line', difficulty: 3 })
    expect(classifyValue('vswr')).toMatchObject({ topic: 'gamma_vswr', difficulty: 1 })
    expect(classifyValue('Y_mS')).toMatchObject({ topic: 'read_y', difficulty: 3 })
    expect(classifyReach(['seriesL', 'seriesC'], 1, false)).toMatchObject({ topic: 'reach_lumped', difficulty: 2 })
    expect(classifyReach(['tline'], 1, false).topic).toBe('reach_line')
    expect(classifyReach(['shuntL', 'seriesC'], 2, true).difficulty).toBe(3)
    expect(classifyMatch([], 1.5, false)).toMatchObject({ topic: 'l_match', difficulty: 2 })
    expect(classifyMatch(['seriesL', 'shuntC'], 1.5, false)).toMatchObject({ topic: 'l_match_tight', difficulty: 3 })
    expect(classifyMatch([], 1.1, false).topic).toBe('l_match_tight')
    expect(classifyMatch([], 2, true).topic).toBe('band_match')
    expect(classifyMatch(['tline'], 1.2, false).topic).toBe('reach_line')
    expect(classifyMatch(['tline', 'openStub'], 1.2, false).topic).toBe('stub_match')
  })
})

describe('recording a graded answer', () => {
  it('moves the skill estimate by the exact rule and keeps per-topic counts', () => {
    const p = learner()
    const { profile, report } = answer(p, classifyMove('shuntC', 'path'), true, 's1', T0)
    expect(profile.skills.lumped_moves.mastery).toBeGreaterThan(p.skills.lumped_moves.mastery)
    expect(profile.skills.lumped_moves.history.at(-1)?.source).toMatch(/^app:/)
    expect(profile.topics?.dir_shuntC).toMatchObject({ seen: 1, correct: 1, recent: [1] })
    expect(report).toMatch(/Recorded automatically.*lumped_moves 0\.30 → 0\.\d\d; which way a shunt C moves the point: 1 of 1 right/)
    // Only that skill changed.
    expect(profile.skills.l_match).toEqual(p.skills.l_match)
  })

  it('aim level: two right at the edge steps up, easy items don\'t count, a miss at the aim steps down', () => {
    let p = learner('intermediate') // mastery 0.55 → start at level 2
    expect(startLevel(p, 'l_match')).toBe(2)
    const easy: GradedMeta = { topic: 'l_match', skill: 'l_match', difficulty: 1 }
    const edge: GradedMeta = { topic: 'l_match', skill: 'l_match', difficulty: 2 }
    const hard: GradedMeta = { topic: 'l_match', skill: 'l_match', difficulty: 3 }
    p = answer(p, easy, true, 's1', at(0, 1)).profile
    p = answer(p, easy, true, 's1', at(0, 2)).profile
    expect(aimFor(p, 'l_match')).toBe(2) // easy wins don't raise it
    p = answer(p, edge, true, 's1', at(0, 3)).profile
    p = answer(p, edge, true, 's1', at(0, 4)).profile
    expect(aimFor(p, 'l_match')).toBe(3)
    p = answer(p, hard, false, 's1', at(0, 5)).profile
    expect(aimFor(p, 'l_match')).toBe(2) // missed at the aim: ease off
    p = answer(p, hard, false, 's1', at(0, 6)).profile
    expect(aimFor(p, 'l_match')).toBe(2) // a miss above the aim is expected, no further drop
    p = answer(p, edge, false, 's1', at(0, 7)).profile
    expect(aimFor(p, 'l_match')).toBe(1)
    expect(answer(p, easy, false, 's1', at(0, 8)).profile.topics?.l_match?.level).toBe(1) // never below 1
  })

  it('spaced review: right answers push the next review out, a miss brings it back tomorrow', () => {
    let p = learner()
    const m = classifyValue('vswr')
    const due = () => (new Date(p.topics!.gamma_vswr!.due).getTime() - new Date(p.topics!.gamma_vswr!.lastSeen).getTime()) / 86_400_000
    p = answer(p, m, true, 's1', at(0)).profile
    expect(due()).toBe(REVIEW_DAYS[1])
    p = answer(p, m, true, 's2', at(1)).profile
    expect(due()).toBe(REVIEW_DAYS[2])
    p = answer(p, m, true, 's3', at(4)).profile
    expect(due()).toBe(REVIEW_DAYS[3])
    p = answer(p, m, false, 's4', at(11)).profile
    expect(due()).toBe(1)
    for (let i = 0; i < 9; i++) p = answer(p, m, true, `s${5 + i}`, at(12 + i * 40)).profile
    expect(due()).toBe(30) // capped at a month
  })

  it('a wrong move answer records the specific misconception once, against its topic', () => {
    let p = learner()
    const m = classifyMove('shuntC', 'path')
    p = answer(p, m, false, 's1', at(0), 'Thinks a shunt C turns the point counter-clockwise').profile
    p = answer(p, m, false, 's1', at(0, 5), 'Thinks a shunt C turns the point counter-clockwise').profile
    expect(p.misconceptions).toHaveLength(1)
    expect(p.misconceptions[0]).toMatchObject({ topic: 'dir_shuntC', count: 2, resolved: false })
  })

  it('never clears in the lesson it appeared; looking better, then cleared, then confirmed; a slip brings it back with a higher bar', () => {
    let p = learner()
    const m = classifyMove('shuntC', 'path')
    p = answer(p, m, false, 's1', at(0), 'Thinks a shunt C turns counter-clockwise').profile
    const same = answer(p, m, true, 's1', at(0, 10))
    expect(same.report).toMatch(/doesn't count toward clearing it \(same lesson it appeared in/)
    p = answer(same.profile, m, true, 's1', at(0, 20)).profile
    expect(misconceptionSignOff(p, p.misconceptions[0])).toMatchObject({ status: 'active', points: 0 }) // right twice, minutes after: followed, not fixed
    const r2 = answer(p, m, true, 's2', at(2))
    expect(r2.profile.misconceptions[0].resolved).toBe(false)
    expect(r2.report).toMatch(/looking better \(evidence 1 of 2;.*Say it's looking better, not fixed/)
    const r3 = answer(r2.profile, m, true, 's3', at(4))
    expect(r3.profile.misconceptions[0].resolved).toBe(true)
    expect(r3.report).toMatch(/misconception cleared, provisionally.*don't call it fixed/)
    expect(misconceptionSignOff(r3.profile, r3.profile.misconceptions[0]).status).toBe('cleared')
    const r4 = answer(r3.profile, m, true, 's4', at(6))
    expect(r4.report).toMatch(/misconception confirmed gone/)
    expect(misconceptionSignOff(r4.profile, r4.profile.misconceptions[0]).status).toBe('confirmed')
    const slip = answer(r4.profile, m, false, 's5', at(9))
    expect(slip.profile.misconceptions[0]).toMatchObject({ resolved: false, count: 2, relapses: 1 })
    expect(slip.report).toMatch(/misconception back.*the bar to clear it again is higher/)
    expect(misconceptionSignOff(slip.profile, slip.profile.misconceptions[0]).required).toBeGreaterThan(2)
  })

  it('keeps every graded answer as it happened, with its topic and skill (bounded), for measures added later', () => {
    let p = learner()
    const m = classifyMove('shuntC', 'path')
    p = recordGraded(p, { meta: { ...m, ctx: 'upper half' }, outcome: 'correct', label: 'q', session: 's1', at: at(0), sure: 'guess', format: 'mcq', helped: true }).profile
    // Recorded raw: right, though it counted as partly right (a guess, with help).
    expect(p.answers).toEqual([{ at: at(0), session: 's1', topic: 'dir_shuntC', skill: 'lumped_moves', difficulty: m.difficulty, outcome: 'correct', sure: 'guess', helped: true, format: 'mcq', ctx: 'upper half' }])
    for (let i = 0; i < ANSWER_LOG_MAX + 5; i++) p = answer(p, m, i % 2 === 0, `s${i}`, at(1 + i / 100)).profile
    expect(p.answers).toHaveLength(ANSWER_LOG_MAX)
    expect(p.answers!.at(-1)!.session).toBe(`s${ANSWER_LOG_MAX + 4}`)
  })

  it('a misconception the tutor logged against a topic is closed the same way', () => {
    let p = learner()
    p = { ...p, misconceptions: [{ id: 'mc1', skill: 'reflection', topic: 'gamma_vswr', description: 'Confuses Γ with VSWR', count: 1, firstSeen: at(0), lastSeen: at(0), resolved: false }] }
    p = answer(p, classifyValue('vswr'), true, 's2', at(1)).profile
    p = answer(p, classifyValue('gamma_mag'), true, 's3', at(3)).profile
    expect(p.misconceptions[0].resolved).toBe(true)
  })
})

describe('notes: few, categorised, current', () => {
  it('replaces near-duplicates and explicit updates instead of piling up', () => {
    let p = learner()
    p = saveNote(p, { category: 'goal', text: 'Designing a 2.4 GHz patch antenna in CST' }, at(0)).profile
    p = saveNote(p, { category: 'goal', text: 'designing a 2.4 GHz patch antenna in CST.' }, at(1)).profile
    expect(p.notes).toHaveLength(1)
    const { profile, id } = saveNote(p, { category: 'struggle', text: 'Mixes up Γ and VSWR' }, at(2))
    p = saveNote(profile, { category: 'struggle', text: 'Γ vs VSWR mostly fixed; still slow on return loss', replaces: id }, at(3)).profile
    expect(p.notes!.filter((n) => n.category === 'struggle')).toEqual([{ id, category: 'struggle', text: 'Γ vs VSWR mostly fixed; still slow on return loss', at: at(3) }])
    p = forgetNote(p, id)
    expect(p.notes!.some((n) => n.id === id)).toBe(false)
  })

  it('keeps at most a few per category, dropping the oldest', () => {
    let p = learner()
    for (let i = 0; i < 12; i++) p = saveNote(p, { category: 'clicked', text: `Explanation number ${i} about topic ${'abcdefghijkl'[i]}` }, at(i)).profile
    const clicked = p.notes!.filter((n) => n.category === 'clicked')
    expect(clicked).toHaveLength(NOTES_PER_CATEGORY)
    expect(clicked[0].text).toMatch(/number 7/)
  })

  it('old plain-text notes carry over when a profile loads', () => {
    const old = { ...createProfile('Old'), tutorNotes: ['2026-10-06: Asks good clarifying questions.', 'No date here'] }
    delete (old as Partial<Profile>).notes
    const p = migrateProfile(old as Profile)
    expect(p.notes).toEqual([
      { id: 'n_old0', category: 'other', text: 'Asks good clarifying questions.', at: '2026-10-06T00:00:00.000Z' },
      { id: 'n_old1', category: 'other', text: 'No date here', at: new Date(0).toISOString() }
    ])
    expect(p.tutorNotes).toEqual([])
    expect(migrateProfile(p).notes).toEqual(p.notes) // idempotent
  })
})

describe('the brief the tutor plans from', () => {
  it('a simulated learner over three lessons: weak spots surface, strong ones step up, reviews come due', () => {
    let p = learner()
    p = saveNote(p, { category: 'goal', text: 'Match a 2.4 GHz patch antenna' }, at(0)).profile
    const dirSC = classifyMove('seriesC', 'path')
    const dirShC = classifyMove('shuntC', 'path')
    const land: GradedMeta = { ...classifyMove('shuntC', 'end_half') }
    // Three lessons: always right on shunt C (and its landing), always wrong on series C.
    for (const [i, s] of ['s1', 's2', 's3'].entries()) {
      p = answer(p, dirShC, true, s, at(i * 2)).profile
      p = answer(p, land, true, s, at(i * 2, 5)).profile
      p = answer(p, dirSC, false, s, at(i * 2, 10), 'Thinks a series C turns clockwise').profile
      p = noteAsked(p, { at: at(i * 2), topic: 'dir_seriesC', difficulty: 1, kind: 'move', text: `Series C from the load, lesson ${i + 1}` })
    }
    const b = learnerBrief(p, at(6)) // a day after the last lesson
    expect(b.weak[0]).toBe('dir_seriesC')
    expect(b.text).toMatch(/Weak topics: dir_seriesC \(which way a series C moves the point: 0\/3 right, recent 0%/)
    expect(b.text).toMatch(/Live misconceptions: \[mc_[^\]]+\] Thinks a series C turns clockwise \(dir_seriesC, 3×\)/)
    expect(b.due).toContain('dir_seriesC') // a miss comes back the next day
    expect(b.due).not.toContain('dir_shuntC') // three right: next review in a week
    expect(aimFor(p, 'land_lumped')).toBe(3) // right at the edge, repeatedly: harder next
    expect(aimFor(p, 'dir_seriesC')).toBe(1)
    expect(b.text).toMatch(/Goals: Match a 2.4 GHz patch antenna/)
    expect(b.text).toMatch(/Recently asked \(vary; don't repeat\): move\/dir_seriesC L1: "Series C from the load, lesson 1"/)
    expect(b.text).toMatch(/- lumped_moves 0\.\d\d · aim level/)
  })

  it('stays small however long the history gets', () => {
    let p = learner()
    const all: TopicId[] = ['plot_z', 'gamma_vswr', 'dir_seriesL', 'dir_shuntC', 'land_lumped', 'l_match', 'dir_line', 'read_y']
    for (let i = 0; i < 400; i++) {
      const topic = all[i % all.length]
      p = answer(p, { topic, skill: topicDef(topic)!.skill, difficulty: 2 }, i % 3 !== 0, `s${Math.floor(i / 10)}`, at(i / 10), `misconception ${i % 7}`).profile
      p = noteAsked(p, { at: at(i / 10), topic, difficulty: 2, kind: 'value', text: `question ${i} `.repeat(10) })
      p = saveNote(p, { category: (['goal', 'preference', 'clicked', 'struggle', 'other'] as const)[i % 5], text: `note ${i} ${'x'.repeat(200)}` }, at(i / 10)).profile
    }
    expect(p.asked).toHaveLength(20)
    expect(p.notes!.length).toBeLessThanOrEqual(5 * NOTES_PER_CATEGORY)
    const b = learnerBrief(p, at(50))
    // Bounded however long the history (each misconception also carries its sign-off status and score).
    // The independence ladder adds a fixed line per ladder skill (about 700 characters), reading stages one more (about 170).
    expect(b.text.length).toBeLessThan(7450)
    expect(JSON.stringify(p.topics).length).toBeLessThan(8000)
  })
})

describe('older misconceptions without a topic', () => {
  it('get one from their wording when it is clear (the learner\'s two real ones)', () => {
    expect(inferTopic({ skill: 'lumped_moves', description: "Thinks series L moves the point counter-clockwise along the constant-r circle (it's clockwise)." })).toBe('dir_seriesL')
    expect(inferTopic({ skill: 'reflection', description: 'Confuses Γ with VSWR: said Γ → infinite for an open (Γ→1, it\'s VSWR that →∞).' })).toBe('gamma_vswr')
    expect(inferTopic({ skill: 'lumped_moves', description: 'Thinks a shunt capacitor turns it anticlockwise' })).toBe('dir_shuntC')
    expect(inferTopic({ skill: 'tlines', description: 'Rotates counter-clockwise when adding line toward the generator' })).toBe('dir_line')
    expect(inferTopic({ skill: 'l_match', description: 'Forgets to check both solutions' })).toBeUndefined()
  })

  it('so graded answers can close them like any other', () => {
    let p = learner()
    p = { ...p, misconceptions: [{ id: 'old', skill: 'lumped_moves', description: 'Thinks series L moves the point counter-clockwise', count: 1, firstSeen: at(0), lastSeen: at(0), resolved: false }] }
    p = answer(p, classifyMove('seriesL', 'path'), true, 's1', at(1)).profile
    p = answer(p, classifyMove('seriesL', 'path'), true, 's2', at(3)).profile
    expect(p.misconceptions[0]).toMatchObject({ resolved: true, topic: 'dir_seriesL' })
  })

  it('a long old note is shortened with an ellipsis, not cut mid-word silently', () => {
    const long = '2026-10-06: ' + 'word '.repeat(80)
    const p = migrateProfile({ ...createProfile('Old'), tutorNotes: [long], notes: undefined } as Profile)
    expect(p.notes![0].text.endsWith('…')).toBe(true)
    expect(p.notes![0].text.length).toBeLessThanOrEqual(240)
  })
})

describe('export and reset', () => {
  /** A learner with some history: lessons' answers, a mistake, a note, a plan. */
  function withHistory(): Profile {
    let p = learner('intermediate')
    p = { ...p, setupComplete: true, preferences: { ...p.preferences, tutorStyle: 'balanced' }, background: { ...p.background, goals: 'Match my patch antenna' } }
    const m = classifyMove('shuntC', 'path')
    p = answer(p, m, false, 's1', at(0), 'Thinks a shunt C turns counter-clockwise').profile
    p = answer(p, m, true, 's2', at(2)).profile
    p = saveNote(p, { category: 'goal', text: 'Match a 2.4 GHz patch' }, at(2)).profile
    return {
      ...p,
      sessions: [{ id: 's1', startedAt: at(0), transcript: [], exercises: [] }],
      observations: [{ at: at(2), session: 's2', skill: 'lumped_moves', topic: 'dir_shuntC', outcome: 'correct', reason: 'right', transfer: true }],
      nextFocus: { picks: [{ skill: 'lumped_moves', why: 'x' }], at: at(2) },
      reading: { reflection: { stage: 'chart', streak: 1, misses: 0, source: 'answers', at: at(2) } }
    }
  }

  it('an exported profile imports with everything, including the answer log and the tutor\'s observations', () => {
    const p = withHistory()
    const back = migrateProfile(JSON.parse(JSON.stringify(exportProfile(p))))
    expect(back.answers).toEqual(p.answers)
    expect(back.observations).toEqual(p.observations)
    expect(back.misconceptions).toEqual(p.misconceptions)
    expect(back.topics).toEqual(p.topics)
    expect(back.ladder).toEqual(p.ladder)
    expect(back.ladderPace).toEqual(p.ladderPace)
    expect(back.reading).toEqual(p.reading)
  })

  it('reset clears what the app learned and keeps who they are and how they like to learn', () => {
    const p = withHistory()
    const r = resetProgress(p)
    expect(r).toMatchObject({ id: p.id, name: p.name, createdAt: p.createdAt, background: p.background, preferences: p.preferences, setupComplete: true })
    expect(r.skills).toEqual(createProfile('x', { experience: 'intermediate' }).skills) // back to their stated experience
    for (const k of ['sessions', 'misconceptions'] as const) expect(r[k]).toEqual([])
    for (const k of ['topics', 'answers', 'observations', 'calibration', 'slips', 'notes', 'nextFocus', 'assessment', 'asked', 'ladder', 'ladderPace', 'reading'] as const) expect(r[k]).toBeUndefined()
    const brief = learnerBrief(r, at(3)).text
    expect(brief).not.toMatch(/shunt C|2\.4 GHz/) // the mistake and the tutor's note are gone
    expect(brief).toMatch(/Goals: Match my patch antenna/) // their own goal stays
  })
})
