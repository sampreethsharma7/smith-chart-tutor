import { countsAsLesson } from '@shared/profile'
import { inferFromStepText, type Coordinates } from '@shared/lesson'
import { defineTools } from '../types'

/** The learner asking to keep practising ("give me one more, a bit harder"). */
export const MORE_PRACTICE = /\b(another (one|problem|question|task|exercise|challenge)|one more|more (problems?|practice|questions?|exercises?|tasks?|of (these|those|that))|next (one|problem|question|task)|(make it|something|bit|little|a) harder|harder (one|problem|question|task)|keep going|(go|try|do) (it |that |this )?again|again\?)/i

/**
 * The lesson's shape, shared with the app: the goal and steps are shown to the
 * learner as a checklist, and completing the goal saves and wraps up the lesson.
 */
/** Lessons in which complete_lesson already asked for the plan (asked once each). */
const askedForPlan = new Set<string>()
/** Learner messages that already held back complete_lesson once (a second attempt goes through). */
const askedForMore = new Set<string>()

export default defineTools([
  {
    name: 'set_lesson_goal',
    description: 'Declare this lesson\'s goal and the 2–4 steps to reach it. Call it when you open a lesson (and again only if you and the learner agree on a new goal). The learner sees it as a checklist. Write both to the learner, briefly.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'One sentence: what the learner will be able to do by the end' },
        steps: { type: 'array', items: { type: 'string' }, description: '2–4 short steps, in order' },
        coordinates: { type: 'string', enum: ['impedance', 'admittance'], description: 'How step 1 reads the chart. If omitted it is inferred from step 1\'s wording, or left unknown (then you must set it before describing any move).' }
      },
      required: ['goal', 'steps']
    },
    activity: () => 'Setting the lesson goal',
    run(a, ctx) {
      const steps = (Array.isArray(a.steps) ? a.steps : [a.steps]).map((s: unknown) => String(s).trim()).filter(Boolean).slice(0, 5)
      if (!String(a.goal ?? '').trim() || steps.length === 0) throw new Error('Give a goal and at least one step.')
      const cur = ctx.session()?.plan
      // A new goal only makes sense after the learner has had a say.
      if (cur && (cur.setAtTurn ?? 0) === ctx.learnerTurns()) {
        throw new Error(`A goal is already set ("${cur.goal}"). Don't set it again; start teaching step ${Math.min(cur.step + 1, cur.steps.length)} now.`)
      }
      // Given, or inferred from step 1's wording, or explicitly unknown: never a silent default.
      const coordinates: Coordinates = a.coordinates === 'admittance' || a.coordinates === 'impedance' ? a.coordinates : inferFromStepText(steps[0])
      ctx.updateSession((s) => ({ ...s, plan: { goal: String(a.goal).trim(), steps, step: 0, setAtTurn: ctx.learnerTurns(), coordinates } }))
      return `Goal shown to the learner with ${steps.length} steps; step 1 is current. Coordinates: ${coordinates}${coordinates === 'unknown' ? ' (set them with set_lesson_coordinates before describing any move)' : ''}. Start it now. Call advance_lesson_step when the learner has completed each step.`
    }
  },
  {
    name: 'advance_lesson_step',
    description: 'Tick off the current step once the LEARNER has done it (shown their reasoning, passed the check, answered correctly), not when you have explained it. Say which coordinates the next step uses if they change.',
    parameters: {
      type: 'object',
      properties: { next_coordinates: { type: 'string', enum: ['impedance', 'admittance'], description: 'How the next step reads the chart. If omitted it is inferred from the next step\'s wording, or left unknown.' } }
    },
    activity: () => 'Step done',
    run(a, ctx) {
      const plan = ctx.session()?.plan
      if (!plan) throw new Error('No lesson goal yet: call set_lesson_goal first.')
      if (ctx.learnerTurns() === 0) throw new Error('The learner has not done anything yet; a step can only be ticked off once they have.')
      if (plan.step >= plan.steps.length) return 'All steps are already done. If the goal is reached, call complete_lesson.'
      const step = plan.step + 1
      // A new step may read the chart differently (series → shunt): given, inferred from its wording, or unknown.
      const coordinates: Coordinates = a.next_coordinates === 'admittance' || a.next_coordinates === 'impedance'
        ? a.next_coordinates
        : step < plan.steps.length ? inferFromStepText(plan.steps[step]) : plan.coordinates ?? 'unknown'
      ctx.updateSession((s) => ({ ...s, plan: { ...plan, step, coordinates, coordinatesInferred: false } }))
      return step >= plan.steps.length
        ? 'That was the last step. If the learner has reached the goal, call complete_lesson now (with your recap in the same reply).'
        : `Step ${step} done; step ${step + 1} of ${plan.steps.length} is now current: "${plan.steps[step]}".`
    }
  },
  {
    name: 'set_lesson_coordinates',
    description: 'Record that the lesson now reads the chart as impedance (z = r + jx) or admittance (y = g + jb). Call it whenever you switch, so the lesson state (and any other tutor model taking over) stays consistent.',
    parameters: {
      type: 'object',
      properties: { coordinates: { type: 'string', enum: ['impedance', 'admittance'] } },
      required: ['coordinates']
    },
    activity: (a) => `Switching to ${a.coordinates} view`,
    run(a, ctx) {
      const plan = ctx.session()?.plan
      if (!plan) throw new Error('No lesson goal yet: call set_lesson_goal first.')
      if (a.coordinates !== 'impedance' && a.coordinates !== 'admittance') throw new Error('coordinates must be "impedance" or "admittance"')
      ctx.updateSession((s) => ({ ...s, plan: { ...plan, coordinates: a.coordinates, coordinatesInferred: false } }))
      return `Lesson state: now reading the chart as ${a.coordinates}. Remember the sign flip: the chart's upper half is x > 0 but b < 0.`
    }
  },
  {
    name: 'complete_lesson',
    description: 'The lesson goal is reached: close the lesson. In the same reply, congratulate the learner specifically and recap. The app then saves the lesson and shows them what changed in their skills. Only the goal being reached by the learner counts, not you explaining it.',
    parameters: {
      type: 'object',
      properties: {
        can_now_do: { type: 'array', items: { type: 'string' }, description: '2–3 short things the learner can now do, written to them ("Read |Γ| off the chart…")' },
        practise_next: { type: 'string', description: 'One thing to practise or learn next' }
      },
      required: ['can_now_do']
    },
    activity: () => 'Wrapping up the lesson',
    endsTurn: true,
    run(a, ctx) {
      const s = ctx.session()
      if (!s || !countsAsLesson(s) || ctx.learnerTurns() < 2) {
        throw new Error('The learner has barely started. Keep teaching toward the goal; complete the lesson only when they have reached it.')
      }
      // "Give me one more" is not the end of a lesson: from a real run, the tutor closed it instead of answering.
      const lastWords = [...s.transcript].reverse().find((t) => t.role === 'user')?.text ?? ''
      if (MORE_PRACTICE.test(lastWords) && !askedForMore.has(s.id + lastWords)) {
        askedForMore.add(s.id + lastWords)
        throw new Error(`The learner just asked for more ("${lastWords.slice(0, 80)}"). Give it now: set the next task or question at the level they asked for. Don't end the lesson while they want to keep going.`)
      }
      if (ctx.followUpPending?.()) {
        throw new Error('They just solved the task: first ask your one follow-up question about their solution. Complete the lesson after they answer or skip it.')
      }
      // The plan for next time is set in the lesson that informs it (asked once; a model that won't isn't blocked).
      if (ctx.profile().nextFocus?.session !== s.id && !askedForPlan.has(s.id)) {
        askedForPlan.add(s.id)
        throw new Error('First call set_next_focus with what they should work on next (from today and their brief), then complete_lesson.')
      }
      const canNowDo = (Array.isArray(a.can_now_do) ? a.can_now_do : [a.can_now_do]).map((x: unknown) => String(x).trim()).filter(Boolean).slice(0, 4)
      ctx.updateSession((x) => ({
        ...x,
        plan: x.plan ? { ...x.plan, step: x.plan.steps.length } : x.plan,
        recap: { canNowDo, practiseNext: a.practise_next ? String(a.practise_next) : undefined }
      }))
      ctx.completeLesson()
      return 'Lesson marked complete. Now write your short recap to the learner; the app saves the lesson after your reply and shows their progress.'
    }
  }
])
