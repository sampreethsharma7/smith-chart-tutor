import { describe, expect, it } from 'vitest'
import { createProfile, migrateProfile, type AnswerRecord, type Profile, type SessionRecord } from './profile'
import { repeatOf, reusedValues } from './repeats'

const NOW = '2026-10-09T12:00:00.000Z'
const lesson = (id: string): SessionRecord => ({ id, startedAt: NOW, transcript: [{ role: 'user', text: 'hi', at: NOW }], exercises: [] })
const answer = (session: string, x: Partial<AnswerRecord> = {}): AnswerRecord =>
  ({ at: NOW, session, topic: 'gamma_vswr', skill: 'reflection', difficulty: 1, outcome: 'correct', sig: 'value:vswr:1.77', ...x } as AnswerRecord)
const profile = (answers: AnswerRecord[], lessons = ['L1', 'L2', 'L3', 'L4']): Profile =>
  ({ ...migrateProfile(createProfile('Riya')), sessions: lessons.map(lesson), answers })

describe('no repeats: an item just answered right isn\'t asked again (the re-run asked the antenna\'s VSWR in four lessons)', () => {
  it('right in this lesson or one of the two before: a repeat', () => {
    expect(repeatOf(profile([answer('L5')]), 'value:vswr:1.77', NOW, 'L5')).toEqual({ thisLesson: true })
    expect(repeatOf(profile([answer('L4')]), 'value:vswr:1.77', NOW, 'L5')).toEqual({ thisLesson: false })
    expect(repeatOf(profile([answer('L3')]), 'value:vswr:1.77', NOW, 'L5')).toEqual({ thisLesson: false })
    // Three lessons back: spaced practice, fine.
    expect(repeatOf(profile([answer('L2')]), 'value:vswr:1.77', NOW, 'L5')).toBeNull()
    // Another item: fine.
    expect(repeatOf(profile([answer('L5')]), 'value:vswr:2.62', NOW, 'L5')).toBeNull()
  })

  it('after a miss it may be asked again (a re-check); the newest answer decides', () => {
    expect(repeatOf(profile([answer('L5', { outcome: 'incorrect' })]), 'value:vswr:1.77', NOW, 'L5')).toBeNull()
    expect(repeatOf(profile([answer('L4', { outcome: 'incorrect' }), answer('L5')]), 'value:vswr:1.77', NOW, 'L5')).toEqual({ thisLesson: true })
  })

  it('a topic due for review may come back from an earlier lesson, not twice in one', () => {
    const due = (p: Profile): Profile => ({ ...p, topics: { gamma_vswr: { due: '2026-10-08T00:00:00.000Z' } as never } })
    expect(repeatOf(due(profile([answer('L4')])), 'value:vswr:1.77', NOW, 'L5')).toBeNull()
    expect(repeatOf(due(profile([answer('L5')])), 'value:vswr:1.77', NOW, 'L5')).toEqual({ thisLesson: true })
  })
})

describe('tasks whose answer is a number they just used aren\'t set (three tasks in a row needed 3.3 nH)', () => {
  const task = (session: string, parts: AnswerRecord['parts']) => answer(session, { format: 'task', sig: `task:${session}`, parts })
  it('every solution reusing values from their last two passed tasks: reused', () => {
    const p = profile([task('L5', [{ value: 3.3e-9, unit: 'H' }]), task('L5', [{ value: 0.66e-12, unit: 'F' }, { value: 3.3e-9, unit: 'H' }])])
    expect(reusedValues(p, [[{ value: 3.32e-9, unit: 'H' }]], 'L5')).toEqual([{ value: 3.32e-9, unit: 'H' }])
    // A second solution with a new value: they have to work something out.
    expect(reusedValues(p, [[{ value: 3.32e-9, unit: 'H' }], [{ value: 1.3e-12, unit: 'F' }]], 'L5')).toBeNull()
    expect(reusedValues(p, [[{ value: 4.8e-9, unit: 'H' }]], 'L5')).toBeNull()
    // An inductance isn't a capacitance.
    expect(reusedValues(p, [[{ value: 3.3e-12, unit: 'F' }]], 'L5')).toBeNull()
  })

  it('only recent passes count, and only the last two', () => {
    expect(reusedValues(profile([task('L1', [{ value: 3.3e-9, unit: 'H' }])]), [[{ value: 3.3e-9, unit: 'H' }]], 'L5')).toBeNull()
    const p = profile([task('L5', [{ value: 3.3e-9, unit: 'H' }]), task('L5', [{ value: 1e-12, unit: 'F' }]), task('L5', [{ value: 2e-12, unit: 'F' }])])
    expect(reusedValues(p, [[{ value: 3.3e-9, unit: 'H' }]], 'L5')).toBeNull()
    expect(reusedValues(profile([task('L5', [{ value: 3.3e-9, unit: 'H' }]), answer('L5', { format: 'task', outcome: 'incorrect', parts: [{ value: 5e-9, unit: 'H' }] })]), [[{ value: 5e-9, unit: 'H' }]], 'L5')).toBeNull()
  })
})
