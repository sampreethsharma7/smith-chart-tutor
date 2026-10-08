import { describe, expect, it } from 'vitest'
import type { SessionRecord } from '@shared/profile'
import { runTool } from '../registry'
import type { ToolContext } from '../types'

function fakeCtx(learnerTurns = 1) {
  let session: SessionRecord = { id: 's', startedAt: 'x', transcript: [{ role: 'user', text: 'hi', at: 'x' }], exercises: [] }
  const ctx = {
    session: () => session,
    updateSession: (fn: (s: SessionRecord) => SessionRecord) => { session = fn(session) },
    learnerTurns: () => learnerTurns,
    completeLesson: () => {}
  } as unknown as ToolContext
  return { ctx, get: () => session }
}

const STEPS = ['Series L and series C: moving along constant-r circles', 'Shunt L and shunt C: moving along constant-g circles', 'Choose one element that moves a given point onto a target circle']

describe('lesson coordinates are never silently defaulted', () => {
  it('a goal set without coordinates infers them from step 1', async () => {
    const { ctx, get } = fakeCtx(0)
    await runTool('set_lesson_goal', { goal: 'Predict moves', steps: STEPS }, ctx)
    expect(get().plan?.coordinates).toBe('impedance')
  })

  it('moving from a series step to a shunt step switches to admittance', async () => {
    const { ctx, get } = fakeCtx(0)
    await runTool('set_lesson_goal', { goal: 'Predict moves', steps: STEPS }, ctx)
    const { ctx: c2 } = { ctx: { ...ctx, learnerTurns: () => 2 } as ToolContext }
    await runTool('advance_lesson_step', {}, c2)
    expect(get().plan?.coordinates).toBe('admittance')
  })

  it('an ambiguous next step becomes unknown rather than keeping the old system', async () => {
    const { ctx, get } = fakeCtx(0)
    await runTool('set_lesson_goal', { goal: 'Predict moves', steps: STEPS, coordinates: 'admittance' }, ctx)
    const c2 = { ...ctx, learnerTurns: () => 2 } as ToolContext
    await runTool('advance_lesson_step', {}, c2) // → step 2 (shunt): admittance
    await runTool('advance_lesson_step', {}, c2) // → step 3 (ambiguous)
    expect(get().plan?.coordinates).toBe('unknown')
    await runTool('set_lesson_coordinates', { coordinates: 'impedance' }, c2)
    expect(get().plan?.coordinates).toBe('impedance')
  })
})

describe('ending a lesson', () => {
  it('is refused right after the learner asks for more, and allowed otherwise', async () => {
    const { MORE_PRACTICE } = await import('./lesson')
    for (const t of ['Give me one more, a bit harder.', 'another one please', 'Can we do more problems?', "Let's go again", 'next one']) expect(MORE_PRACTICE.test(t)).toBe(true)
    for (const t of ['Thanks, that makes sense now.', 'Done!', 'I matched it at 2.4 GHz']) expect(MORE_PRACTICE.test(t)).toBe(false)
    let session: SessionRecord = { id: 's', startedAt: 'x', transcript: [{ role: 'user', text: 'Nice. Give me one more, a bit harder.', at: 'x' }], exercises: [{ title: 'x', passed: true, attempts: 1, at: 'x' }] }
    // The plan for next time is already set in this lesson (see the next test for when it isn't).
    const profile = { nextFocus: { picks: [], at: 'x', session: 's' } }
    const ctx = { session: () => session, profile: () => profile, updateSession: (fn: (s: SessionRecord) => SessionRecord) => { session = fn(session) }, learnerTurns: () => 3, completeLesson: () => {} } as unknown as ToolContext
    const r = await runTool('complete_lesson', { can_now_do: ['x'] }, ctx)
    expect(r.isError).toBe(true)
    session = { ...session, transcript: [...session.transcript, { role: 'user', text: 'Thanks, that was great.', at: 'y' }] }
    expect((await runTool('complete_lesson', { can_now_do: ['x'] }, ctx)).isError).toBe(false)
  })

  it('asks for the plan for next time first, once; a model that won\'t is not blocked', async () => {
    let session: SessionRecord = { id: 'plan-1', startedAt: 'x', transcript: [{ role: 'user', text: 'Thanks, got it.', at: 'x' }], exercises: [{ title: 'x', passed: true, attempts: 1, at: 'x' }] }
    const profile = { nextFocus: { picks: [], at: 'x', session: 'an earlier lesson' } }
    let completed = 0
    const ctx = { session: () => session, profile: () => profile, updateSession: (fn: (s: SessionRecord) => SessionRecord) => { session = fn(session) }, learnerTurns: () => 3, completeLesson: () => { completed++ } } as unknown as ToolContext
    const first = await runTool('complete_lesson', { can_now_do: ['x'] }, ctx)
    expect(first.isError).toBe(true)
    expect(first.content).toMatch(/set_next_focus/)
    expect(completed).toBe(0)
    expect((await runTool('complete_lesson', { can_now_do: ['x'] }, ctx)).isError).toBe(false)
    expect(completed).toBe(1)
  })
})
