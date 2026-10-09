import { create } from 'zustand'
import { createProfile, type Profile, type SkillId } from '@shared/profile'
import { answerFor, chanceRight, chatLine, COURSE_VERSION, independenceSteps, itemSignature, learn, MAX_ACTIONS, REQUEST_CAP_PER_LESSON, rng, scoreCourse, START_ABILITY, sureOf, type CourseIssue, type CourseItem, type CourseLesson, type CourseReport } from '@shared/course'
import { DEFAULT_TASK_KINDS, findReach, gradeQuestion } from '@shared/rf/tasks'
import { matchCandidates } from '@shared/rf/design'
import { inputImpedance, loadImpedance, type NetworkElement } from '@shared/rf/network'
import { milestones, titleOf } from '@shared/capstone'
import type { ValuesSeen } from '@shared/reading'
import { callStats, useTutor } from '@/agent/tutor'
import { checkExerciseAsync, gradeOpenQuestion, revealValues, skipQuestion, unsureQuestion } from '@/agent/answers'
import { watchIssues } from '@/agent/issueLog'
import { agentBusy, switchLock, useApp, type View } from './app'
import { useBench } from './bench'
import { useStudio, type Exercise } from './studio'
import { gradeExercise, onProjectLoad, restoreProjectLoad } from './exercise'

interface Running {
  text: string
  lesson: number
  of: number
  requests: number
  providerLabel: string
}

interface CourseState {
  running: Running | null
  /** How the last run ended, when it didn't simply finish (stopped, an error): shown on the card */
  lastNote: { text: string; error: boolean } | null
  /** Starts a run; resolves when it's over. A refusal to start comes back as a message. */
  run(opts: { providerId: string; lessons: number; seed: number }): Promise<string | null>
  stop(): void
}

/**
 * Course runs live here (not in a component) so they keep going across tab switches. One at a time;
 * it uses the app itself: a throwaway learner profile, the real tutor and the real answer paths.
 * While it runs, nothing else can switch the profile, the model or the chart (switchLock), and a
 * marker in the settings lets the next start undo it if the app closes mid-run.
 */
export const useCourse = create<CourseState>((set, get) => ({
  running: null,
  lastNote: null,
  async run(opts) {
    if (get().running) return 'A course run is already going.'
    if (agentBusy()) return 'Wait for the tutor or the design assistant to finish first.'
    if (Object.keys(useBench.getState().running).length) return 'Wait for the benchmark to finish first: a course run counts every request the app makes.'
    const app = useApp.getState()
    const provider = app.settings.providers.find((p) => p.id === opts.providerId)
    if (!provider) return 'Pick a model first.'
    stopped = false
    set({ running: { text: 'Setting up a scripted learner…', lesson: 0, of: opts.lessons, requests: 0, providerLabel: provider.label }, lastNote: null })
    const before = { profileId: app.profile?.id ?? null, providerId: app.settings.activeProviderId, view: app.view }
    const learner: Profile = { ...createProfile('Course run (scripted learner)', {
      experience: 'new',
      role: 'Third-year electrical engineering student',
      goals: 'Match a 2.4 GHz patch antenna for my final-year project',
      mentorNotes: 'Go slowly, few formulas.'
    }), setupComplete: true, skippedAssessment: true }
    learner.preferences = { ...learner.preferences, tutorStyle: 'balanced' }
    let report: CourseReport | null = null
    let failed: string | null = null
    let created = false
    try {
      await useApp.getState().markCourseRun({ learnerId: learner.id, profileId: before.profileId, providerId: before.providerId })
      await useApp.getState().addProfile(learner)
      created = true
      await until(() => useTutor.getState().profileId === learner.id, 10000)
      await useApp.getState().setActiveProvider(provider.id)
      await useApp.getState().setView('studio')
      switchLock.on = true
      report = await course(learner.id, provider, opts, (r) => set({ running: { ...get().running!, ...r } }))
    } catch (e) {
      failed = (e as Error).message
    } finally {
      switchLock.on = false
      // Each step on its own: one that fails mustn't leave the user on the learner or the run marked as going.
      const step = async (f: () => unknown) => { try { await f() } catch (e) { console.error(e) } }
      await step(() => until(() => !useTutor.getState().busy, 60000))
      watchIssues(null)
      // Its chat goes with it: an empty conversation is saved as none, so no file outlives the profile.
      await step(() => useTutor.getState().reset())
      await step(() => before.providerId !== useApp.getState().settings.activeProviderId && useApp.getState().setActiveProvider(before.providerId))
      await step(() => before.profileId && useApp.getState().profiles.some((p) => p.id === before.profileId) && useApp.getState().selectProfile(before.profileId))
      if (created) await step(() => useApp.getState().deleteProfile(learner.id))
      await step(() => useApp.getState().markCourseRun(null))
      await step(() => useApp.getState().setView(before.view as View))
      if (report) await step(() => useApp.getState().saveCourseRun(report!))
      const note = failed ? `The run failed before it could start: ${failed}` : report?.stopped ? `${report.stopped} The lessons taught so far were scored.` : null
      set({ running: null, lastNote: note ? { text: note, error: !!failed || !!report?.lessons.some((l) => l.ended === 'error') } : null })
    }
    return null
  },
  stop() {
    stopped = true
    useTutor.getState().stop()
  }
}))

let stopped = false
/** How long to wait before saying "ok" again after a failed request (tests shorten it) */
export const courseTiming = { retryMs: 8000 }

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(ok: () => boolean, ms: number) {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('The app did not get ready in time.')
    await pause(100)
  }
}
const idle = () => until(() => !useTutor.getState().busy, 10 * 60 * 1000)

/** The run itself: lesson after lesson on the tutor's pick, the scripted learner acting between turns. */
async function course(profileId: string, provider: { id: string; label: string; model: string }, opts: { lessons: number; seed: number }, progress: (r: Partial<Running>) => void): Promise<CourseReport> {
  const r = rng(opts.seed)
  const ability: Record<string, number> = { ...START_ABILITY }
  const items: CourseItem[] = []
  const issues: CourseIssue[] = []
  const lessons: CourseLesson[] = []
  const req0 = callStats.requests
  const cap = REQUEST_CAP_PER_LESSON * opts.lessons
  let lessonNo = 0
  watchIssues((found) => { for (const i of found) issues.push({ lesson: lessonNo, kind: i.kind, detail: i.detail }) })
  // The learner's profile as last seen: the report is still built if something went wrong mid-lesson.
  let seen = useApp.getState().profile!
  const profile = () => {
    const p = useApp.getState().profile
    if (!p || p.id !== profileId) throw new Error('The learner profile was switched during the run.')
    return (seen = p)
  }
  const startSteps = independenceSteps(profile())
  let stopReason: string | undefined
  let streak = 0
  let lastMissed = false

  for (lessonNo = 1; lessonNo <= opts.lessons; lessonNo++) {
    if (stopped) { stopReason = 'Stopped by you.'; break }
    const t0 = Date.now(), q0 = callStats.requests, k0 = callStats.tokens
    const lesson: CourseLesson = { n: lessonNo, ended: 'cap', skills: [], actions: 0, cards: 0, tasks: 0, stalls: 0, unsolved: 0, recap: false, requests: 0, tokens: 0, ms: 0, steps: 0 }
    const say = (text: string) => progress({ text: `Lesson ${lessonNo} of ${opts.lessons}: ${text}`, lesson: lessonNo, requests: callStats.requests - req0 })
    say('the tutor is opening the lesson…')
    let sinceCard = 0
    let errors = 0
    const checkedTasks = new Set<string>()
    const hintAsked = new Set<string>()
    const stuck = new Map<string, number>()
    const tutor = () => useTutor.getState()
    try {
      await tutor().startSession()
      await idle()
      for (;;) {
        profile()
        if (stopped) { lesson.ended = 'stopped'; stopReason = 'Stopped by you.'; break }
        if (callStats.requests - req0 >= cap) { lesson.ended = 'stopped'; stopReason = `Stopped at the request limit (${cap}).`; break }
        if (tutor().session?.goalReachedAt) { lesson.ended = 'goal'; break }
        if (lesson.actions >= MAX_ACTIONS) { lesson.ended = 'cap'; break }
        // A failed request (rate limit, network): wait and say "ok" again, twice at most.
        const last = tutor().items.at(-1)
        if (last?.kind === 'error') {
          if (++errors > 2) { lesson.ended = 'error'; lesson.error = last.text.slice(0, 200); break }
          say('the request failed; retrying shortly…')
          await pause(courseTiming.retryMs * errors)
          if (stopped) continue
          await tutor().send('ok')
          await idle()
          continue
        }
        lesson.actions++
        const st = useStudio.getState()
        const p = st.prediction
        const ex = st.exercise
        if (p) {
          sinceCard = 0
          if (!p.key) {
            // An ungraded "predict first" card: any answer will do.
            say('answering a prediction…')
            const a = p.kind === 'mcq' && p.choices?.length ? p.choices[Math.floor(r() * p.choices.length)] : p.kind === 'click' ? 'clicked near the centre' : 'I think it moves toward the centre'
            if (p.kind === 'click') st.setPrediction({ ...p, answered: a, answeredGamma: { re: 0.1, im: 0.1 } })
            await gradeOpenQuestion(a).finish?.()
            await idle()
            continue
          }
          const skill = (p.graded?.skill ?? p.skill ?? 'chart_basics') as SkillId
          const ab = ability[skill] ?? 0.1
          const covered = p.values === 'covered' && !p.revealed
          // The beginner's shortcuts: uncover the values, ask for help, now and then skip.
          if (covered && ab < 0.5 && r() < 0.3) { revealValues(); continue }
          if (!p.helped && ab < 0.3 && r() < 0.2) {
            say('asking for help with a question…')
            unsureQuestion()
            await pause(50)
            await idle()
            continue
          }
          if (r() < 0.02) { skipQuestion(); await idle(); continue }
          const cur = useStudio.getState().prediction!
          const typed = cur.kind === 'click' && !!cur.values && r() < 0.1
          const right = r() < chanceRight(ab, { difficulty: cur.graded?.difficulty, rung: cur.graded?.rung, covered: cur.values === 'covered' && !cur.revealed, revealed: cur.revealed || typed, helped: cur.helped })
          const a = answerFor(cur.key!, right, r)
          if (!a) { skipQuestion(); await idle(); continue }
          const sure = sureOf(right, ab, r)
          if (cur.kind === 'click') useStudio.getState().setPrediction({ ...cur, answered: a.text, answeredGamma: a.gamma, typed })
          const after = useStudio.getState().prediction!
          const values: ValuesSeen | undefined = !after.values ? undefined : after.typed ? 'typed' : after.values === 'covered' && after.revealed ? 'revealed' : after.values
          const outcome = gradeQuestion(cur.key!, a).status
          say(`answering a question (${right ? 'right' : 'wrong'})…`)
          const g = gradeOpenQuestion(a.choice ?? a.text, sure, a.reason)
          if (g.problem !== null || !g.finish) { skipQuestion(); await idle(); continue }
          lesson.cards++
          items.push({ lesson: lessonNo, sig: itemSignature(cur.key!), skill, difficulty: cur.graded?.difficulty, rung: cur.graded?.rung, values, ...(after.values ? { cover: after.values } : {}), outcome: outcome === 'correct' ? 'correct' : outcome === 'partial' ? 'partial' : 'incorrect', kind: cur.key!.type })
          ability[skill] = learn(ab, right)
          streak = right ? streak + 1 : 0
          lastMissed = !right
          await g.finish()
          await idle()
          continue
        }
        if (ex && ex.status === 'active') {
          sinceCard = 0
          // The project's final task, with its load changed on the chart: put it back, as the card offers.
          if (ex.capstone && !onProjectLoad(ex)) restoreProjectLoad()
          const skill = (ex.graded?.skill ?? ex.skill ?? 'l_match') as SkillId
          const ab = ability[skill] ?? 0.1
          if (!ex.helped && ab < 0.3 && !hintAsked.has(ex.id) && r() < 0.2) {
            hintAsked.add(ex.id)
            say('asking for a hint on a task…')
            await tutor().send("I'm not sure how to start this one, can you give me a hint?")
            await idle()
            continue
          }
          const right = r() < Math.min(0.95, chanceRight(ab, { difficulty: ex.graded?.difficulty, rung: ex.graded?.rung, helped: ex.helped }) + 0.15 * ex.attempts)
          const solved = solveTask(ex)
          if (!solved) {
            // The app's solvers found nothing that passes: say so, then ask to move on.
            // A gap in the script, not the tutor's doing: counted apart, not as a stretch without practice.
            const n = (stuck.get(ex.id) ?? 0) + 1
            stuck.set(ex.id, n)
            if (n === 1) lesson.unsolved++
            say('stuck on a task…')
            await tutor().send(n === 1 ? "I'm stuck on this one: I can't find parts that work. Can you help?" : "I still can't do this one. Can we move on to something else?")
            await idle()
            continue
          }
          // A wrong try: the right parts, one of them the wrong size.
          const net = right ? solved : solved.map((e, i) => (i === solved.length - 1 ? { ...e, value: e.value * (r() < 0.5 ? 0.45 : 2.2) } : e))
          useStudio.getState().set('network', net, `Built ${net.length} element${net.length === 1 ? '' : 's'} for the task`)
          say(`trying a task (${right ? 'right' : 'wrong'})…`)
          const first = !checkedTasks.has(ex.id)
          checkedTasks.add(ex.id)
          const g = await checkExerciseAsync()
          if (first) {
            lesson.tasks++
            items.push({ lesson: lessonNo, sig: taskSignature(ex), skill, difficulty: ex.graded?.difficulty, rung: ex.graded?.rung, outcome: g?.passed ? 'correct' : 'incorrect', kind: ex.kind ?? 'match' })
          }
          ability[skill] = learn(ab, !!g?.passed)
          streak = g?.passed ? streak + 1 : 0
          lastMissed = !g?.passed
          await idle()
          continue
        }
        // No card open: say something short, the way a beginner would.
        const lastTutor = [...tutor().items].reverse().find((i) => i.kind === 'tutor')
        const line = chatLine({ asked: /\?\s*$/.test(lastTutor?.text.trim() ?? ''), lastMissed, streak, sinceCard }, r)
        sinceCard++
        if (sinceCard === 3) lesson.stalls++
        say(`replying "${line}"…`)
        await tutor().send(line)
        await idle()
      }
    } catch (e) {
      // A request that never came back, the profile switched…: this lesson ends here; the report keeps what was done.
      lesson.ended = 'error'
      lesson.error = (e as Error).message.slice(0, 200)
      tutor().stop()
    }
    const s = tutor().session
    lesson.goal = s?.plan?.goal
    lesson.recap = !!s?.recap
    lesson.skills = [...new Set(items.filter((i) => i.lesson === lessonNo && i.skill).map((i) => i.skill!))]
    // Notes for the next lesson; the last one (or one cut short) needs none: the learner goes after it.
    const more = lessonNo < opts.lessons && lesson.ended !== 'stopped' && lesson.ended !== 'error'
    say(more ? 'the tutor is writing its lesson notes…' : 'saving the lesson…')
    await idle().catch(() => {})
    if (useApp.getState().profile?.id === profileId) await tutor().endSession({ notesOnly: !more })
    lesson.requests = callStats.requests - q0
    lesson.tokens = callStats.tokens - k0
    lesson.ms = Date.now() - t0
    lesson.steps = independenceSteps(useApp.getState().profile?.id === profileId ? profile() : seen)
    lessons.push(lesson)
    if (lesson.ended === 'stopped' || lesson.ended === 'error') {
      stopReason ??= `Lesson ${lessonNo} failed: ${lesson.error ?? 'error'}`
      break
    }
  }
  const p = useApp.getState().profile?.id === profileId ? profile() : seen
  const capstone = p.capstone ? (() => {
    const ms = milestones(p, p.capstone!)
    return { title: titleOf(p.capstone!), met: ms.filter((m) => m.met).length, total: ms.length, done: !!p.capstone!.done }
  })() : undefined
  const { facts, scores } = scoreCourse({ lessons, items, issues, startSteps, capstone })
  return {
    id: `course_${Date.now().toString(36)}`,
    version: COURSE_VERSION,
    at: new Date().toISOString(),
    providerId: provider.id,
    providerLabel: provider.label,
    model: provider.model,
    seed: opts.seed,
    lessonsAsked: opts.lessons,
    ...(stopReason ? { stopped: stopReason } : {}),
    lessons,
    items,
    issues: issues.slice(0, 300),
    facts,
    scores
  }
}

/** The task itself, not its wording: its kind, target, parts and load. */
function taskSignature(ex: Exercise): string {
  const s = useStudio.getState()
  const Z = loadImpedance(s.load, ex.freqHz, s.datasets)
  const r = (x: number) => Math.round(x)
  return `task:${ex.kind ?? 'match'}:${r(Z.re)},${r(Z.im)}:${ex.target ? JSON.stringify(ex.target) : ex.maxVswr}:${[...(ex.allowedKinds ?? [])].sort().join('+')}`
}

/**
 * A network that passes the task, found with the app's own solvers and checked with its grading:
 * a standard L or stub match for a match task, a search for a reach task (from the network already
 * there, else from the load). The chart is left as it was. Null when none is found.
 */
export function solveTask(ex: Exercise): NetworkElement[] | null {
  const st = useStudio.getState()
  const keep = st.network
  const f = ex.freqHz
  const kinds = ex.allowedKinds?.length ? ex.allowedKinds : null
  const ZL = loadImpedance(st.load, f, st.datasets)
  const fits = (n: NetworkElement[]) => (!kinds || n.every((e) => kinds.includes(e.kind))) && (ex.maxElements === undefined || n.length <= ex.maxElements)
  const passes = (n: NetworkElement[]) => {
    useStudio.setState({ network: n })
    return gradeExercise(ex).passed
  }
  const ids = (n: NetworkElement[]) => n.map((e, i) => ({ ...e, id: `sim_${Date.now().toString(36)}_${i}` }))
  try {
    const tries: NetworkElement[][] = []
    if (ex.kind === 'reach' && ex.target) {
      const use = kinds ?? DEFAULT_TASK_KINDS
      const room = (ex.maxElements ?? keep.length + 2) - keep.length
      if (room > 0) tries.push([...keep, ...findReach(inputImpedance(ZL, keep, f), ex.target, use, Math.min(2, room), f, st.z0).network])
      tries.push(findReach(ZL, ex.target, use, Math.min(2, ex.maxElements ?? 2), f, st.z0).network)
    } else {
      for (const c of matchCandidates(ZL, st.z0, f)) tries.push(c.elements)
    }
    for (const n of tries) if (n.length && fits(n) && passes(n)) return ids(n)
    return null
  } finally {
    useStudio.setState({ network: keep })
  }
}
