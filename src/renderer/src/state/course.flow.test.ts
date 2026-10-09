import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatRequest, Part } from '@shared/llm'

// ── A fake tutor model and an in-memory app: a whole course run, end to end, through the real tutor loop ──
const app = vi.hoisted(() => ({
  profile: null as any,
  profiles: [] as any[],
  settings: { providers: [{ id: 'fake', label: 'Fake model', model: 'fake-1', supportsTools: true }], activeProviderId: 'other', benchmarks: {}, courseRuns: [] as any[] } as any,
  view: 'models',
  deleted: [] as string[],
  requests: 0,
  summaries: 0,
  fail: 0,
  stopAt: 0,
  /** Stop while the failed request's retry is waiting */
  stopOnFail: false,
  markers: [] as any[],
  sentAfterStop: 0,
  stopPressed: false
}))

vi.mock('@/state/app', async () => {
  const { createProfile, migrateProfile } = await import('@shared/profile')
  const me = migrateProfile(createProfile('Me', { experience: 'basics' }))
  app.profile = me
  app.profiles = [me]
  const select = async (id: string) => {
    app.profile = app.profiles.find((p) => p.id === id)
    const { useTutor } = await import('@/agent/tutor')
    useTutor.setState({ profileId: id })
  }
  const state = {
    get profile() { return app.profile },
    get profiles() { return app.profiles },
    get settings() { return app.settings },
    get view() { return app.view },
    updateProfile: async (fn: (p: any) => any) => {
      app.profile = fn(app.profile)
      app.profiles = app.profiles.map((p) => (p.id === app.profile.id ? app.profile : p))
    },
    addProfile: async (p: any) => { app.profiles = [...app.profiles, p]; await select(p.id) },
    selectProfile: select,
    deleteProfile: async (id: string) => { app.deleted.push(id); app.profiles = app.profiles.filter((p) => p.id !== id) },
    setActiveProvider: async (id: string) => { app.settings = { ...app.settings, activeProviderId: id } },
    setView: async (v: string) => { app.view = v },
    saveCourseRun: async (r: any) => { app.settings = { ...app.settings, courseRuns: [...app.settings.courseRuns, r] } },
    markCourseRun: async (m: any) => {
      app.markers.push(m)
      const { courseRunActive: _x, ...rest } = app.settings
      app.settings = m ? { ...rest, courseRunActive: m } : rest
    }
  }
  return {
    activeProvider: () => app.settings.providers.find((p: any) => p.id === app.settings.activeProviderId),
    agentBusy: () => false,
    switchLock: { on: false },
    useApp: { getState: () => state, subscribe: () => () => {} },
    registerBusy: () => {},
    api: () => ({
      llm: {
        chat: (req: ChatRequest) => {
          const summary = req.system.stable.startsWith('You write short notes')
          if (summary) app.summaries++
          else app.requests++
          if (app.stopPressed) app.sentAfterStop++
          const parts = summary ? text('Summary.') : tutor(req)
          const message: ChatMessage = { role: 'assistant', parts }
          return { requestId: `r${app.requests}`, done: Promise.resolve({ type: 'done', result: { message, stopReason: 'end', usage: { inputTokens: 100, outputTokens: 10 }, timing: { ttftMs: 1, totalMs: 1 } } }) }
        },
        abort: () => {}
      },
      conversation: { save: async () => {}, get: async () => null }
    })
  }
})
vi.stubGlobal('window', { addEventListener: () => {} })

const text = (t: string): Part[] => [{ type: 'text', text: t }]
const call = (name: string, args: Record<string, unknown>, t = ''): Part[] => [...(t ? text(t) : []), { type: 'tool_call', id: `c_${name}_${Math.random()}`, name, args }]

/**
 * The fake tutor: opens with a goal and a click question, then a value question, then a task to
 * match the load, a follow-up on their solution once it passes, then closes the lesson. Each lesson asks for a different point.
 */
let lessonNo = 0
function tutor(req: ChatRequest): Part[] {
  const last = req.messages.at(-1)!
  const results = last.parts.filter((p): p is Extract<Part, { type: 'tool_result' }> => p.type === 'tool_result')
  const said = last.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n')
  if (results.some((r) => r.name === 'complete_lesson')) return text('Well done: that is the lesson.')
  if (results.some((r) => r.name === 'set_lesson_goal')) return call('ask_locate', { question: `Click z = ${lessonNo} + j1`, point: { r: lessonNo, x: 1 } })
  // A turn that ended on a card has the learner's next message added to its tool results: read what they said first.
  if (results.length && !said) return text('Have a go.')
  if (/\[Lesson (\d+) start\]/.test(said)) {
    lessonNo = Number(/\[Lesson (\d+) start\]/.exec(said)![1])
    if (app.fail > 0 && lessonNo === 2) {
      app.fail--
      if (app.stopOnFail) { app.stopPressed = true; useCourse.getState().stop() }
      throw new Error('boom')
    }
    if (app.stopAt === lessonNo) useCourse.getState().stop()
    return call('set_lesson_goal', { goal: 'Plot and match a load', steps: ['Plot a point in impedance', 'Match it'], coordinates: 'impedance' }, 'Hi!')
  }
  // The follow-up on their solution answered: close the lesson.
  if (/\[Question answered \(follow-up/.test(said)) return [...call('set_next_focus', { picks: [{ skill: 'l_match', why: 'More matching.' }] }), ...call('complete_lesson', { can_now_do: ['Match a load'] }, 'Nice match!')]
  if (/\[Question answered\]/.test(said)) {
    return /VSWR/.test(said)
      ? call('create_exercise', { title: 'Match it', instructions: 'Match the load to VSWR ≤ 2 with two L/C parts.', freq_hz: 2.4e9, max_vswr: 2 })
      : call('ask_value', { question: 'What is the VSWR of the load?', quantity: 'vswr', from: 'load', title: 'VSWR of the load' })
  }
  if (/\[(Exercise|Task) check #\d+\] PASS/.test(said)) return call('ask_value', { question: 'With your match in place, what is the VSWR now?', quantity: 'vswr', title: 'VSWR after the match' }, 'Good.')
  if (/\[(Exercise|Task) check/.test(said)) return text('Not yet: look at the size of your last part.')
  return text('Sure. Shall we carry on?')
}

const { useCourse, courseTiming } = await import('./course')
courseTiming.retryMs = 10
const { useTutor } = await import('@/agent/tutor')
const { useStudio, DEFAULT_SNAPSHOT } = await import('./studio')

describe('a course run drives the real tutor through lessons and scores them', () => {
  it('runs every lesson on a throwaway profile, then deletes it and puts the profile, model and page back', async () => {
    useStudio.getState().loadSnapshot({ ...DEFAULT_SNAPSHOT, load: { kind: 'fixed', R: 30, X: 20 } })
    const me = app.profile.id
    const err = await useCourse.getState().run({ providerId: 'fake', lessons: 3, seed: 4 })
    expect(err).toBeNull()
    // Back where it was: the user's profile, their model, their page; the learner gone.
    expect(app.profile.id).toBe(me)
    expect(app.settings.activeProviderId).toBe('other')
    expect(app.view).toBe('models')
    expect(app.deleted).toHaveLength(1)
    expect(app.profiles.map((p) => p.id)).toEqual([me])
    expect(useCourse.getState().running).toBeNull()
    // A marker was kept while it ran (for a restart to undo it), then cleared.
    expect(app.markers[0]).toMatchObject({ profileId: me, providerId: 'other' })
    expect(app.markers.at(-1)).toBeNull()
    expect(app.settings.courseRunActive).toBeUndefined()
    // Notes for the next lesson come from the model; the last lesson's don't (the learner is deleted after it).
    expect(app.summaries).toBe(2)

    const r = app.settings.courseRuns.at(-1)
    expect(r.lessons).toHaveLength(3)
    expect(r.providerId).toBe('fake')
    expect(r.model).toBe('fake-1')
    for (const l of r.lessons) {
      expect(l.goal).toBe('Plot and match a load')
      expect(l.cards).toBeGreaterThanOrEqual(1)
      expect(l.tasks).toBeLessThanOrEqual(1)
      expect(['goal', 'cap']).toContain(l.ended)
      expect(l.requests).toBeGreaterThan(3)
      // Ended at the goal: the tutor's recap was saved.
      if (l.ended === 'goal') expect(l.recap).toBe(true)
    }
    expect(r.lessons.reduce((a: number, l: any) => a + l.tasks, 0)).toBeGreaterThan(0)
    // Some lessons end at the goal (the learner gets the task right eventually, within the action limit).
    expect(r.facts.finished).toBeGreaterThan(0)
    expect(r.facts.requests).toBe(app.requests + app.summaries)
    expect(r.facts.tokens).toBe(110 * r.facts.requests)
    // What it asked, by what was asked: a new point each lesson, the same VSWR each time (a repeat when it was answered right).
    expect(r.items.filter((i: any) => i.kind === 'locate').map((i: any) => i.sig)).toHaveLength(new Set(r.items.filter((i: any) => i.kind === 'locate').map((i: any) => i.sig)).size)
    const loadVswr = r.items.filter((i: any) => i.sig === 'value:vswr:2.04')
    expect(loadVswr.length).toBeGreaterThan(1)
    // Each one after a right answer to it is a repeat (the same task each lesson can add more).
    expect(r.facts.duplicates).toBeGreaterThanOrEqual(loadVswr.slice(0, -1).filter((i: any) => i.outcome === 'correct').length)
    expect(r.scores.overall).toBeGreaterThan(0)
    expect(r.scores.overall).toBeLessThanOrEqual(1)
  }, 60000)

  it('the same seed gives the same learner: the same answers in the same order', async () => {
    const runOnce = async () => {
      lessonNo = 0
      useStudio.getState().loadSnapshot({ ...DEFAULT_SNAPSHOT, load: { kind: 'fixed', R: 30, X: 20 } })
      expect(await useCourse.getState().run({ providerId: 'fake', lessons: 2, seed: 9 })).toBeNull()
      return app.settings.courseRuns.at(-1).items.map((i: any) => `${i.sig}:${i.outcome}`)
    }
    expect(await runOnce()).toEqual(await runOnce())
  }, 60000)

  it('a failed request is retried; Stop ends the run and still cleans up', async () => {
    app.fail = 1
    useStudio.getState().loadSnapshot({ ...DEFAULT_SNAPSHOT, load: { kind: 'fixed', R: 30, X: 20 } })
    app.stopAt = 3 // pressed while the tutor opens lesson 3
    expect(await useCourse.getState().run({ providerId: 'fake', lessons: 4, seed: 2 })).toBeNull()
    app.stopAt = 0
    const r = app.settings.courseRuns.at(-1)
    expect(r.stopped).toBe('Stopped by you.')
    expect(r.lessons).toHaveLength(3)
    expect(r.lessons[2].ended).toBe('stopped')
    expect(r.lessons[1].ended).not.toBe('error') // the failure on lesson 2 was retried
    expect(app.profiles).toHaveLength(1)
    expect(useTutor.getState().busy).toBe(false)
  }, 60000)

  it('review: Stop while a failed request waits to be retried sends nothing more', async () => {
    app.fail = 1
    app.stopOnFail = true
    app.sentAfterStop = 0
    useStudio.getState().loadSnapshot({ ...DEFAULT_SNAPSHOT, load: { kind: 'fixed', R: 30, X: 20 } })
    expect(await useCourse.getState().run({ providerId: 'fake', lessons: 3, seed: 2 })).toBeNull()
    app.stopOnFail = false
    app.stopPressed = false
    expect(app.sentAfterStop).toBe(0)
    const r = app.settings.courseRuns.at(-1)
    expect(r.lessons).toHaveLength(2)
    expect(r.lessons[1].ended).toBe('stopped')
    expect(useCourse.getState().lastNote?.text).toMatch(/^Stopped by you\. The lessons taught so far were scored\./)
  }, 60000)

  it('review: a lesson that keeps failing ends the run with a partial report and a message, and everything is put back', async () => {
    app.fail = 3
    const me = app.profile.id
    useStudio.getState().loadSnapshot({ ...DEFAULT_SNAPSHOT, load: { kind: 'fixed', R: 30, X: 20 } })
    expect(await useCourse.getState().run({ providerId: 'fake', lessons: 4, seed: 2 })).toBeNull()
    const r = app.settings.courseRuns.at(-1)
    expect(r.lessons).toHaveLength(2)
    expect(r.lessons[1]).toMatchObject({ ended: 'error' })
    expect(r.lessons[1].error).toMatch(/boom/)
    expect(r.stopped).toMatch(/^Lesson 2 failed: .*boom/)
    expect(useCourse.getState().lastNote).toMatchObject({ error: true })
    expect(app.profile.id).toBe(me)
    expect(app.profiles).toHaveLength(1)
    app.fail = 0
  }, 60000)

  it('review: does not start while a benchmark is running (it would count its requests)', async () => {
    const { useBench } = await import('./bench')
    useBench.setState({ running: { fake: { text: 'x', checks: [] } } })
    expect(await useCourse.getState().run({ providerId: 'fake', lessons: 1, seed: 1 })).toMatch(/benchmark/)
    useBench.setState({ running: {} })
  })

  it('refuses a second run while one is going, and a model that isn\'t there', async () => {
    expect(await useCourse.getState().run({ providerId: 'nope', lessons: 1, seed: 1 })).toMatch(/Pick a model/)
    const first = useCourse.getState().run({ providerId: 'fake', lessons: 1, seed: 1 })
    expect(await useCourse.getState().run({ providerId: 'fake', lessons: 1, seed: 1 })).toMatch(/already/)
    expect(await first).toBeNull()
  }, 60000)
})
