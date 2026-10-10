import { ELEMENT_LABEL, loadImpedance, type ElementKind, type NetworkElement } from '@shared/rf/network'
import { metricsFromZ } from '@shared/rf/metrics'
import { solveLMatch } from '@shared/rf/solvers'
import { fmtC, fmtEng, fmtHz } from '@/lib/format'
import { uid } from '@/state/studio'
import { FOLLOW_UP, gradeExercise } from '@/state/exercise'
import type { Exercise } from '@/state/studio'
import { defineTools, type ToolContext } from '../types'
import { applyScenario, ELEMENT_KINDS, SCENARIO_PROPS } from './chart'
import { aimFor, classifyMatch, inSituation, noteAsked, recordGraded, topicDef } from '@shared/memory'
import { findReach, regionOf } from '@shared/rf/tasks'
import { c, type Complex } from '@shared/rf/complex'
import { matchIsGuided, rungOfMatch, withRung } from '@shared/ladder'
import { fitRung, RUNG_REASON } from '../ladderFit'
import { checkRepeat, checkReuse } from '../repeatFit'
import { taskSignature } from '@shared/course'
import { partValuesOf } from '@shared/rf/giveaway'
import { capstoneProblem, completeProject, milestones, projectPassNote, projectLoad as loadOfProject, stageOf, titleOf, type Capstone } from '@shared/capstone'
import type { Dataset, LoadModel } from '@shared/rf/network'

const LUMPED_KINDS: ElementKind[] = ['seriesL', 'seriesC', 'shuntL', 'shuntC']
const LINE_KINDS: ElementKind[] = ['tline', 'openStub', 'shortStub']
/** Wording that asks for two parts: "two parts", "2 elements", "both parts", an L-match or L-network */
const TWO_PARTS = /\b(two|2)\s+(parts|elements|components)\b|\bboth (parts|elements)\b|\bL[- ]?(match|network)\b/i

/** One lumped part that alone brings the load to VSWR ≤ maxVswr at f, if there is one. */
function onePartMatch(ZL: Complex, z0: number, f: number, maxVswr: number, kinds: ElementKind[]): NetworkElement | null {
  const lumped = kinds.filter((k) => LUMPED_KINDS.includes(k))
  if (!lumped.length) return null
  // Inside the VSWR circle is within |Γ| = (s − 1)/(s + 1) of the centre.
  const r = findReach(ZL, { type: 'point', z: c(1, 0), tol: (maxVswr - 1) / (maxVswr + 1), as: 'z' }, lumped, 1, f, z0)
  return r.ok && r.network.length === 1 ? r.network[0] : null
}

/**
 * The final task of their project fills itself in from the project (capstone.ts), so it can't be
 * watered down: its load, frequency, band, VSWR and parts. Only once every milestone is met.
 */
function capstoneTask(c: Capstone | undefined, a: any, datasets: Array<{ id: string; name: string }>): { args: any; load: LoadModel } {
  if (!c) throw new Error('They have no project yet: set one with set_capstone first.')
  if (c.judge) throw new Error('Their project is a judge project (no build): it is done when they judge worked matches (ask_spot_error), not with a task.')
  if (c.done) throw new Error('Their project is already done: propose the next one with set_capstone.')
  const load = loadOfProject(c, datasets as Dataset[])
  if (!load) throw new Error(`Their project uses their data "${(c.load as { datasetName: string }).datasetName}", which isn't loaded now: ask them to import it again (Load panel), then set the task.`)
  return {
    load,
    args: {
      ...a,
      freq_hz: c.f0,
      max_vswr: c.maxVswr,
      band_low_hz: c.band?.low,
      band_high_hz: c.band?.high,
      allowed_kinds: c.parts === 'lumped' ? LUMPED_KINDS : c.parts === 'lines' ? LINE_KINDS : undefined,
      max_elements: undefined,
      title: a.title || titleOf(c),
      // The project's load and Z0, whatever the tutor passed (a different Z0 could ease the target).
      scenario: { ...(a.scenario ?? {}), load: undefined, z0: c.z0 ?? 50 }
    }
  }
}

/**
 * A pass the tutor found (check_exercise, or closing it as passed) without the learner pressing Check:
 * recorded as the Check button would (answers.ts), so it reaches their record, and the final task of their
 * project completes the project. Only the first pass counts. What to tell the tutor comes back.
 */
async function recordTutorPass(ctx: ToolContext, ex: Exercise): Promise<string> {
  const next: Exercise = { ...ex, attempts: ex.attempts + 1, status: 'passed' }
  ctx.studio.setExercise(next)
  ctx.recordExercise({ title: ex.title, skill: ex.skill, passed: true, attempts: next.attempts })
  const at = new Date().toISOString()
  const session = ctx.session?.()?.id
  let report = ''
  let marked: boolean | null = null
  await ctx.updateProfile((p) => {
    let q = p
    if (ex.graded) {
      // Partly theirs when they talked it through or needed several tries (the Check button's rule).
      const r = recordGraded(q, { meta: ex.graded, outcome: 'correct', label: ex.title, session: session ?? 'none', at, format: 'task', helped: !!ex.helped || next.attempts > 1, parts: partValuesOf(ctx.studio.network) })
      report = r.report
      q = r.profile
    }
    if (ex.capstone) {
      const c = completeProject(q, ex.capstone.at, at, session)
      marked = c.marked
      q = c.profile
    }
    return q
  })
  return [
    '[Recorded as passed, the same as pressing Check.]',
    ...(marked === null ? [] : [projectPassNote(marked)]),
    ...(report ? [`[Learner memory] ${report}`] : []),
    `[Follow-up] ${FOLLOW_UP}`
  ].join('\n')
}

export default defineTools([
  {
    name: 'create_exercise',
    description: 'Give the learner a hands-on matching task shown as a card with a "Check" button. Choose the scenario (load, frequency; the band only if the task is about bandwidth), the goal (VSWR ≤ max at freq_hz, optionally over a band) and constraints (max elements, allowed element kinds). Pitch difficulty at the learner\'s level. Grading is automatic and exact.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        instructions: { type: 'string', description: 'What the learner should do, written to them. Do not include the answer.' },
        skill: { type: 'string', description: 'Skill id this practises' },
        freq_hz: { type: 'number' },
        max_vswr: { type: 'number', description: 'Pass threshold, e.g. 1.2 for a tight match or 2 for a band' },
        band_low_hz: { type: 'number' },
        band_high_hz: { type: 'number' },
        max_elements: { type: 'number' },
        allowed_kinds: { type: 'array', items: { type: 'string', enum: ELEMENT_KINDS } },
        scenario: { type: 'object', properties: SCENARIO_PROPS, description: 'Chart setup for the exercise (network is cleared automatically)' },
        capstone: { type: 'boolean', description: 'The final task of their project (see Project in the brief): the app fills in its load, frequency, band, VSWR and parts. Only once every milestone is met.' },
        ...RUNG_REASON
      },
      required: ['title', 'instructions', 'freq_hz', 'max_vswr']
    },
    activity: (a) => `New exercise: ${a.title}`,
    endsTurn: true,
    run(a0, ctx) {
      let a = a0
      let projectLoad: LoadModel | undefined
      const project = a0.capstone ? ctx.profile?.()?.capstone : undefined
      if (a0.capstone) {
        const p = ctx.profile?.()
        if (p && project && stageOf(p, project) === 'route') {
          const left = milestones(p, project).filter((x) => !x.met).map((x) => x.words)
          throw new Error(`Not yet: the project's final task opens when every milestone is met. Still to go: ${left.join('; ')}. Work toward those first.`)
        }
        const t = capstoneTask(project, a0, ctx.studio.datasets)
        a = t.args
        projectLoad = t.load
      }
      if (!Number.isFinite(a.freq_hz) || a.freq_hz <= 0) throw new Error('freq_hz must be a positive number in Hz')
      // Feasibility check before touching the chart: a lumped-only exercise must have a
      // solution with practical part values, otherwise tell the model why.
      const before = ctx.studio.snapshot()
      applyScenario(ctx, { design_freq_hz: a.freq_hz, ...(a.scenario ?? {}), clear_network: true })
      // Before reading the state: ctx.studio is a snapshot, and the checks below must see the project's load.
      if (projectLoad) ctx.studio.setLoad(projectLoad, 'the final task of your project uses its own load')
      const s = ctx.studio
      const kinds: string[] = a.allowed_kinds ?? []
      const band = !!(a.band_low_hz && a.band_high_hz)
      let onePartNote = ''
      let solutions: Array<Array<{ value: number; unit: 'H' | 'F' | 'deg' }>> = []
      const lumpedOnly = kinds.length > 0 && kinds.every((k) => !/tline|Stub/.test(k))
      if (project) {
        // The project's own check (across its band, with its parts), not the one-frequency L-match one below.
        const problem = capstoneProblem(project, s.datasets)
        if (problem) {
          s.loadSnapshot({ ...before })
          throw new Error(`The project can't be set as a task: ${problem}. Change the project with set_capstone (tell them why).`)
        }
      } else if (lumpedOnly || (kinds.length === 0 && (a.max_elements ?? 2) <= 2)) {
        const ZL = loadImpedance(s.load, a.freq_hz, s.datasets)
        const already = metricsFromZ(ZL, s.z0).vswr <= (a.max_vswr ?? 1.5)
        const practical = (k: string, v: number) => (k.endsWith('L') ? v >= 0.05e-9 && v <= 500e-9 : k.endsWith('C') ? v >= 0.01e-12 && v <= 500e-12 : true)
        const sols = solveLMatch(ZL, s.z0, a.freq_hz).filter((sol) =>
          sol.elements.every((e) => practical(e.kind, e.value) && (kinds.length === 0 || kinds.includes(e.kind))))
        if (already || sols.length === 0) {
          s.loadSnapshot({ ...before }) // undo the scenario change
          const why = already
            ? `the load is already matched there (VSWR ${metricsFromZ(ZL, s.z0).vswr.toFixed(2)}), so there is nothing to do`
            : `no two-element L-match with practical values (0.05–500 nH, 0.01–500 pF${kinds.length ? ', allowed kinds' : ''}) exists for Z = ${fmtC(ZL, 'Ω')} at ${fmtHz(a.freq_hz)}`
          throw new Error(`Exercise not created: ${why}. Pick a frequency near where the load is used (check get_chart_state / analyze_sweep), or change the load in "scenario".`)
        }
        // A task that asks for two parts (or an L-match) on a load one part can match isn't one: one part
        // passes it (a novice re-run: 25 + j25 Ω already sits on g = 1, and one shunt C passed "a full L-match").
        const one = !band && a.max_elements !== 1 ? onePartMatch(ZL, s.z0, a.freq_hz, a.max_vswr ?? 1.5, kinds.length ? (kinds as ElementKind[]) : LUMPED_KINDS) : null
        if (one && TWO_PARTS.test(`${a.title ?? ''} ${a.instructions ?? ''}`)) {
          s.loadSnapshot({ ...before })
          throw new Error(`Exercise not created: it asks for two parts, but one part already matches this load (${ELEMENT_LABEL[one.kind]} ${fmtEng(one.value, one.kind.endsWith('L') ? 'H' : 'F')} gives VSWR ≤ ${a.max_vswr ?? 1.5}), so it isn't a two-part task. Pick a load off the r = 1 and g = 1 circles (one part can't reach the centre from there), or make it a one-part task (max_elements: 1).`)
        }
        if (one) onePartNote = ` Note: one part alone (${ELEMENT_LABEL[one.kind]} ${fmtEng(one.value, one.kind.endsWith('L') ? 'H' : 'F')}) passes this task.`
        solutions = sols.map((sol) => partValuesOf(sol.elements))
      }
      // Not one they just did, nor one whose answers are part values they just used (repeats.ts). The
      // project's final task is exempt: it is their project's own load, whatever came before.
      const sig = taskSignature('match', c(ctx.derived().design.load.z.re, ctx.derived().design.load.z.im), `vswr ${a.max_vswr ?? 1.5}${band ? ` ${a.band_low_hz}-${a.band_high_hz}` : ''}`, kinds)
      if (!project) {
        try {
          checkRepeat(ctx, sig)
          if (solutions.length) checkReuse(ctx, solutions)
        } catch (e) {
          s.loadSnapshot({ ...before })
          throw e
        }
      }
      // A task graded across a band needs the band on screen; a one-frequency task doesn't
      // (the design point already marks freq_hz).
      if (a.band_low_hz || a.band_high_hz) s.setShowBand(true, 'tutor', 'the exercise is graded across a band')
      if (ctx.studio.showBand) {
        // Keep the exercise frequency (and band) inside the sweep so the learner can see it.
        const lo = Math.min(a.freq_hz, a.band_low_hz ?? a.freq_hz)
        const hi = Math.max(a.freq_hz, a.band_high_hz ?? a.freq_hz)
        if (lo < s.sweep.start || hi > s.sweep.stop) s.set('sweep', { ...s.sweep, start: lo * 0.8, stop: hi * 1.2 })
        for (const f of [a.band_low_hz, a.band_high_hz].filter(Boolean)) ctx.studio.addMarker(f)
      }
      s.setAnnotations(() => [])
      const maxVswr = Number.isFinite(a.max_vswr) && a.max_vswr > 1 ? a.max_vswr : 1.5
      const ZL = ctx.derived().design.load.z
      const kindsGiven = Array.isArray(a.allowed_kinds) ? a.allowed_kinds : undefined
      const instructions = String(a.instructions ?? '')
      // The project's final task is rated by the project, not by how the tutor words it, and is never
      // refused as too easy: its route already took them to the level it needs.
      const named = project ? '' : instructions
      const graded = withRung(
        inSituation(classifyMatch(kindsGiven ?? [], maxVswr, band, matchIsGuided(kindsGiven, named)), `${regionOf(ZL)}, ${band ? 'across a band' : 'one frequency'}`),
        rungOfMatch(kindsGiven, maxVswr, band, named)
      )
      let fit = ''
      if (!project) {
        try {
          fit = fitRung(ctx, graded, a.rung_reason)
        } catch (e) {
          s.loadSnapshot({ ...before }) // refused: leave the chart as it was
          throw e
        }
      }
      ctx.updateProfile?.((p) => noteAsked(p, { at: new Date().toISOString(), topic: graded.topic, difficulty: graded.difficulty, kind: 'match', text: String(a.title) }))?.catch?.(() => {})
      const aim = ctx.profile?.() ? aimFor(ctx.profile(), graded.topic) : undefined
      s.setExercise({
        id: uid('ex'),
        graded: { ...graded, sig },
        title: a.title,
        instructions: a.instructions,
        skill: a.skill,
        freqHz: a.freq_hz,
        maxVswr,
        band: a.band_low_hz && a.band_high_hz ? { fLow: a.band_low_hz, fHigh: a.band_high_hz } : undefined,
        maxElements: a.max_elements,
        allowedKinds: a.allowed_kinds as ElementKind[] | undefined,
        attempts: 0,
        status: 'active',
        hints: [],
        // Graded on the project's own load and Z0, and tied to this project (it may be changed while the card is open).
        ...(project && projectLoad ? { capstone: { at: project.at, load: projectLoad, z0: s.z0, ...(project.load.kind === 'data' ? { datasetName: project.load.datasetName } : {}) } } : {})
      })
      return `Exercise card shown. Practises: ${topicDef(graded.topic)!.name} (${graded.topic}), level ${graded.difficulty}${aim !== undefined ? `; their aim for it is ${aim}` : ''}.${fit} Now wait for the learner to work on it; they will press Check or talk to you.${onePartNote}`
    }
  },
  {
    name: 'check_exercise',
    description: 'Grade the learner\'s current network against the active exercise (exact numbers). The learner\'s own "Check" presses are reported to you automatically, so only call this if you need a fresh grade.',
    parameters: { type: 'object', properties: {} },
    activity: () => 'Grading the exercise',
    async run(_a, ctx) {
      const ex = ctx.studio.exercise
      if (!ex) return 'No active exercise.'
      const g = gradeExercise(ex)
      // Passed while they talked it through instead of pressing Check: it counts the same (the project too).
      if (g.passed && ex.status !== 'passed') return `${JSON.stringify(g)}\n${await recordTutorPass(ctx, ex)}`
      return g
    }
  },
  {
    name: 'close_exercise',
    description: 'Close the active exercise card and record the outcome in the session log.',
    parameters: { type: 'object', properties: { outcome: { type: 'string', enum: ['passed', 'given_up'] } }, required: ['outcome'] },
    activity: () => 'Closing the exercise',
    async run(a, ctx) {
      const ex = ctx.studio.exercise
      if (!ex) return 'No active exercise.'
      // "Passed" is the app's call, not the tutor's: a pass not yet recorded is checked and recorded now.
      if (a.outcome === 'passed' && ex.status !== 'passed') {
        const g = gradeExercise(ex)
        if (!g.passed) throw new Error(`It hasn't passed: ${g.summary}. Let them keep working, or close it as given_up.`)
        const note = await recordTutorPass(ctx, ex)
        ctx.studio.setExercise(null)
        return `Closed. ${note}`
      }
      ctx.recordExercise({ title: ex.title, skill: ex.skill, passed: a.outcome === 'passed', attempts: ex.attempts })
      ctx.studio.setExercise(null)
      // Giving up on a task they never passed is graded evidence too (a pass was recorded when it happened).
      if (a.outcome === 'given_up' && ex.status !== 'passed' && ex.graded && ctx.updateProfile) {
        let report = ''
        await ctx.updateProfile((p) => {
          const r = recordGraded(p, { meta: ex.graded!, outcome: 'incorrect', label: ex.title, session: ctx.session?.()?.id ?? 'none', at: new Date().toISOString() })
          report = r.report
          return r.profile
        })
        return `Closed. ${report}`
      }
      return 'Closed.'
    }
  },
  {
    name: 'ask_prediction',
    description: 'Ask the learner to commit to a prediction BEFORE something is revealed (e.g. "where will the point move if you add a shunt C?"). kind=mcq shows choice buttons, kind=click asks them to click a point on the chart, kind=text lets them type. Their answer comes back to you as their next message. Predict-then-verify is the core learning loop.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        kind: { type: 'string', enum: ['mcq', 'click', 'text'] },
        choices: { type: 'array', items: { type: 'string' } }
      },
      required: ['question', 'kind']
    },
    activity: () => 'Asking for a prediction',
    endsTurn: true,
    run(a, ctx) {
      // From a real run: an mcq card with no choices left the learner nothing to click.
      const kind = a.kind === 'mcq' || a.kind === 'click' ? a.kind : 'text'
      const question = String(a.question ?? '').trim()
      if (!question) throw new Error('Give the "question" to ask.')
      const choices: string[] = [...new Set<string>((Array.isArray(a.choices) ? a.choices : []).map((x: unknown) => String(x).trim()).filter(Boolean))]
      if (kind === 'mcq' && choices.length < 2) {
        throw new Error('A multiple-choice prediction needs "choices": at least two options (e.g. ["Clockwise", "Counter-clockwise"]). Or use kind "text".')
      }
      ctx.studio.setPrediction({ id: uid('pr'), question, kind, ...(kind === 'mcq' ? { choices: choices.slice(0, 6) } : {}) })
      return 'Prediction card shown. Stop here and wait for the answer.'
    }
  }
])
