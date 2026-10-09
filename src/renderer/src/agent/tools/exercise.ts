import { loadImpedance, type ElementKind } from '@shared/rf/network'
import { metricsFromZ } from '@shared/rf/metrics'
import { solveLMatch } from '@shared/rf/solvers'
import { fmtC, fmtHz } from '@/lib/format'
import { uid } from '@/state/studio'
import { gradeExercise } from '@/state/exercise'
import { defineTools } from '../types'
import { applyScenario, ELEMENT_KINDS, SCENARIO_PROPS } from './chart'
import { aimFor, classifyMatch, inSituation, noteAsked, recordGraded, topicDef } from '@shared/memory'
import { regionOf } from '@shared/rf/tasks'
import { matchIsGuided, rungOfMatch, withRung } from '@shared/ladder'
import { fitRung, RUNG_REASON } from '../ladderFit'

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
        ...RUNG_REASON
      },
      required: ['title', 'instructions', 'freq_hz', 'max_vswr']
    },
    activity: (a) => `New exercise: ${a.title}`,
    endsTurn: true,
    run(a, ctx) {
      if (!Number.isFinite(a.freq_hz) || a.freq_hz <= 0) throw new Error('freq_hz must be a positive number in Hz')
      // Feasibility check before touching the chart: a lumped-only exercise must have a
      // solution with practical part values, otherwise tell the model why.
      const before = ctx.studio.snapshot()
      applyScenario(ctx, { design_freq_hz: a.freq_hz, ...(a.scenario ?? {}), clear_network: true })
      const s = ctx.studio
      const kinds: string[] = a.allowed_kinds ?? []
      const lumpedOnly = kinds.length > 0 && kinds.every((k) => !/tline|Stub/.test(k))
      if (lumpedOnly || (kinds.length === 0 && (a.max_elements ?? 2) <= 2)) {
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
      const band = !!(a.band_low_hz && a.band_high_hz)
      const ZL = ctx.derived().design.load.z
      const kindsGiven = Array.isArray(a.allowed_kinds) ? a.allowed_kinds : undefined
      const instructions = String(a.instructions ?? '')
      const graded = withRung(
        inSituation(classifyMatch(kindsGiven ?? [], maxVswr, band, matchIsGuided(kindsGiven, instructions)), `${regionOf(ZL)}, ${band ? 'across a band' : 'one frequency'}`),
        rungOfMatch(kindsGiven, maxVswr, band, instructions)
      )
      let fit: string
      try {
        fit = fitRung(ctx, graded, a.rung_reason)
      } catch (e) {
        s.loadSnapshot({ ...before }) // refused: leave the chart as it was
        throw e
      }
      ctx.updateProfile?.((p) => noteAsked(p, { at: new Date().toISOString(), topic: graded.topic, difficulty: graded.difficulty, kind: 'match', text: String(a.title) }))?.catch?.(() => {})
      const aim = ctx.profile?.() ? aimFor(ctx.profile(), graded.topic) : undefined
      s.setExercise({
        id: uid('ex'),
        graded,
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
        hints: []
      })
      return `Exercise card shown. Practises: ${topicDef(graded.topic)!.name} (${graded.topic}), level ${graded.difficulty}${aim !== undefined ? `; their aim for it is ${aim}` : ''}.${fit} Now wait for the learner to work on it; they will press Check or talk to you.`
    }
  },
  {
    name: 'check_exercise',
    description: 'Grade the learner\'s current network against the active exercise (exact numbers). The learner\'s own "Check" presses are reported to you automatically, so only call this if you need a fresh grade.',
    parameters: { type: 'object', properties: {} },
    activity: () => 'Grading the exercise',
    run(_a, ctx) {
      const ex = ctx.studio.exercise
      if (!ex) return 'No active exercise.'
      return gradeExercise(ex)
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
