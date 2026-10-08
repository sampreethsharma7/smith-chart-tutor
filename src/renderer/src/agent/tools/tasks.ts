import { c, isFiniteC, type Complex } from '@shared/rf/complex'
import { gammaFromZ, metricsFromZ } from '@shared/rf/metrics'
import { applyElement, ELEMENT_LABEL, inputImpedance, loadImpedance, type ElementKind, type NetworkElement } from '@shared/rf/network'
import {
  admittanceOf, DEFAULT_TASK_KINDS, describeTarget, expectedValue, findReach, fmtNorm, moveQuestion, parseTarget,
  QUANTITIES, regionOf, type Quantity
} from '@shared/rf/tasks'
import { MISTAKES, spotQuestion, type Mistake } from '@shared/rf/spot'
import { componentFor, componentForMove } from '@shared/rf/calc'
import { MISTAKE_CONFUSION } from '@shared/patterns'
import { fmtEng, fmtHz } from '@/lib/format'
import { aimFor, classifyLocate, classifyMove, classifyReach, classifyValue, inSituation, noteAsked, topicDef, type GradedMeta, type TopicId } from '@shared/memory'
import { uid } from '@/state/studio'
import { defineTools, type ToolContext } from '../types'
import { applyScenario, ELEMENT_KINDS, SCENARIO_PROPS } from './chart'
import { typicalValue } from './compute'

/**
 * Graded tasks and questions beyond matching. The tutor designs them; the app
 * computes the right answer, checks the task is possible, and grades exactly.
 */

const POINT = {
  type: 'object',
  description: 'Normalized point: {r, x} for z = r + jx, or {g, b} for y = g + jb',
  properties: { r: { type: 'number' }, x: { type: 'number' }, g: { type: 'number' }, b: { type: 'number' } }
}

const ELEMENT = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ELEMENT_KINDS },
    value: { type: 'number', description: 'H, F, Ω, or degrees for lines/stubs' }
  },
  required: ['kind']
}

/** Where a question starts: the load, the input after the learner's network, or a point (from_point). */
const FROM = {
  from: { type: 'string', enum: ['load', 'input'], description: 'Default: input if the learner has a network, else load' },
  from_point: { ...POINT, description: 'Start at this normalized point instead: {r, x} or {g, b}' }
}

const valueText = (kind: ElementKind, v: number) =>
  kind === 'tline' || kind.endsWith('Stub') ? `${Math.round(v * 10) / 10}°` : fmtEng(v, kind.endsWith('L') ? 'H' : kind.endsWith('C') ? 'F' : 'Ω')

/** Normalized point from {r, x} / {g, b}, or undefined. */
function normPoint(p: any): Complex | undefined {
  if (!p || typeof p !== 'object') return undefined
  if (typeof p.r === 'number') return c(p.r, p.x ?? 0)
  if (typeof p.g === 'number') return admittanceOf(c(p.g, p.b ?? 0))
  return undefined
}

/** Starting impedance (Ω) for a question: the load, the input after the learner's network, or a given point. */
function startZ(a: { from?: unknown; from_point?: unknown }, ctx: ToolContext, f: number): { Z: Complex; what: string } {
  const s = ctx.studio
  const ZL = loadImpedance(s.load, f, s.datasets)
  const from = a.from
  // A point may also arrive in "from" itself (models mix the two up).
  const p = normPoint(a.from_point) ?? normPoint(from)
  if (p) return { Z: c(p.re * s.z0, p.im * s.z0), what: `z = ${fmtNorm(p)}` }
  const useInput = from === 'input' || (from !== 'load' && s.network.length > 0)
  return useInput ? { Z: inputImpedance(ZL, s.network, f), what: 'the input point (after your network)' } : { Z: ZL, what: 'the load' }
}

function parseElement(e: any, f: number, z0: number): NetworkElement {
  const raw = typeof e === 'string' ? { kind: e } : e
  if (!raw || !ELEMENT_KINDS.includes(raw.kind)) throw new Error(`Give "element": {"kind": one of ${ELEMENT_KINDS.join(', ')}, "value": …}.`)
  const value = Number.isFinite(raw.value) && raw.value > 0 ? raw.value : typicalValue(raw.kind, f, z0)
  return { id: 'q', kind: raw.kind, value, zc: z0, refHz: f }
}

const insideChart = (z: Complex) => isFiniteC(z) && z.re >= -1e-9

const short = (q: string) => (q.length > 60 ? `${q.slice(0, 57)}…` : q)

/**
 * Remember what was set (so it isn't repeated) and tell the tutor what it practises,
 * how hard it is and where this learner's level for it stands.
 */
function remember(ctx: ToolContext, m: GradedMeta, kind: string, text: string): string {
  ctx.updateProfile?.((p) => noteAsked(p, { at: new Date().toISOString(), topic: m.topic, difficulty: m.difficulty, kind, text }))?.catch?.(() => {})
  const p = ctx.profile?.()
  const aim = p ? aimFor(p, m.topic) : undefined
  const fit = aim === undefined ? '' : m.difficulty < aim ? ' (easier than their aim: fine as a warm-up or a confidence check)' : m.difficulty > aim ? ' (harder than their aim: a stretch; expect to support them)' : ' (right at their aim)'
  return ` Practises: ${topicDef(m.topic)!.name} (${m.topic}), level ${m.difficulty}${aim !== undefined ? `; their aim for it is ${aim}` : ''}${fit}.`
}

const MAJOR = [0, 0.2, 0.5, 1, 2, 5]
const onMajor = (z: Complex) => MAJOR.includes(Math.round(z.re * 100) / 100) && MAJOR.includes(Math.abs(Math.round(z.im * 100) / 100))

export default defineTools([
  {
    name: 'create_target_task',
    description: 'Hands-on task card: the learner builds or extends the network until the point lands on a target, e.g. "with one series element, get onto the g = 1 circle" (the first half of an L-match), "reach the real axis with a line", "land on z = 1 + j1". Graded exactly when they press Check. The app first checks the task is possible with the elements you allow, and refuses an impossible or already-solved one. Use it to practise single moves and intermediate steps; use create_exercise for a full match to a VSWR.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        instructions: { type: 'string', description: 'What to do, written to the learner. No answer.' },
        target: {
          type: 'object',
          description: 'Where the point must land: {point: {r, x} or {g, b}} or {circle: {family: "r"|"g"|"x"|"b"|"vswr", value}}; optional tolerance (Γ distance for a point, value units for a circle)',
          properties: {
            point: POINT,
            circle: { type: 'object', properties: { family: { type: 'string', enum: ['r', 'g', 'x', 'b', 'vswr'] }, value: { type: 'number' } }, required: ['family', 'value'] },
            tolerance: { type: 'number' }
          }
        },
        max_elements: { type: 'number', description: 'Most elements in the WHOLE network when checked, including kept ones (default: one more than it has now)' },
        allowed_kinds: { type: 'array', items: { type: 'string', enum: ELEMENT_KINDS }, description: 'Default: series/shunt L and C' },
        keep_network: { type: 'boolean', description: 'Keep the learner\'s current network and continue from its input point (default false: start from the load)' },
        show_target: { type: 'boolean', description: 'Draw the target on the chart (default true). Set false when finding it is part of the task.' },
        freq_hz: { type: 'number', description: 'Default: the design frequency' },
        skill: { type: 'string', description: 'Skill id this practises' },
        scenario: { type: 'object', properties: SCENARIO_PROPS, description: 'Optional chart setup first (a new load starts fresh)' }
      },
      required: ['title', 'instructions', 'target']
    },
    activity: (a) => `New task: ${a.title}`,
    endsTurn: true,
    run(a, ctx) {
      const target = parseTarget(a.target)
      const before = ctx.studio.snapshot()
      const keep = a.keep_network === true
      try {
        if (a.scenario) applyScenario(ctx, { ...a.scenario, clear_network: !keep })
        else if (!keep) ctx.studio.set('network', [])
        if (Number.isFinite(a.freq_hz) && a.freq_hz > 0) ctx.studio.set('designFreq', a.freq_hz)
        const s = ctx.studio
        const f = s.designFreq
        const kinds = (Array.isArray(a.allowed_kinds) ? a.allowed_kinds : DEFAULT_TASK_KINDS).filter((k: ElementKind) => ELEMENT_KINDS.includes(k)) as ElementKind[]
        if (!kinds.length) throw new Error('allowed_kinds has no valid element kinds.')
        const have = s.network.length
        const maxElements = Number.isFinite(a.max_elements) && a.max_elements >= 1 ? Math.round(a.max_elements) : have + 1
        const toAdd = maxElements - have
        if (toAdd < 1) throw new Error(`max_elements counts the whole network, and it already has ${have} element(s). To let the learner add one more, use max_elements ${have + 1}; or set keep_network false to start again from the load.`)
        const Z = inputImpedance(loadImpedance(s.load, f, s.datasets), s.network, f)
        const z = c(Z.re / s.z0, Z.im / s.z0)
        if (!insideChart(z)) throw new Error('The starting point is off the chart (open or short); set a different load.')
        const found = findReach(Z, target, kinds, Math.min(toAdd, 2), f, s.z0)
        if (found.ok && found.network.length === 0) {
          throw new Error(`The point (z = ${fmtNorm(z)}) is already on ${describeTarget(target)}: there is nothing to do. Pick another target or start point.`)
        }
        if (!found.ok && toAdd <= 2) {
          throw new Error(`Not possible: with up to ${toAdd} of ${kinds.map((k) => ELEMENT_LABEL[k]).join(', ')} (practical values) the point z = ${fmtNorm(z)} can't reach ${describeTarget(target)}. Allow other element kinds or more elements, or pick a target on a circle the point can move along.`)
        }
        s.setAnnotations(() => [])
        const graded = inSituation(classifyReach(kinds, toAdd, target.type === 'point'), `${regionOf(z)} → ${target.type === 'point' ? 'a point' : `a ${target.family} circle`}`)
        s.setExercise({
          id: uid('ex'),
          kind: 'reach',
          graded,
          title: String(a.title),
          instructions: String(a.instructions),
          skill: a.skill,
          freqHz: f,
          target,
          showTarget: a.show_target !== false,
          maxElements,
          allowedKinds: Array.isArray(a.allowed_kinds) ? kinds : undefined,
          attempts: 0,
          status: 'active',
          hints: []
        })
        const sol = found.ok
          ? `One solution (FOR YOUR VERIFICATION ONLY, never reveal unprompted): ${found.network.map((e) => `${ELEMENT_LABEL[e.kind]} ${valueText(e.kind, e.value)}`).join(' → ')}.`
          : 'No solution found with two elements; more may be needed.'
        return `Task card shown: get the point from z = ${fmtNorm(z)} onto ${describeTarget(target)} (±${target.tol}). ${sol}${remember(ctx, graded, 'reach', String(a.title))} Now wait for the learner; their Check results come to you.`
      } catch (e) {
        ctx.studio.loadSnapshot(before)
        throw e
      }
    }
  },
  {
    name: 'ask_locate',
    description: 'Graded question: the learner clicks a spot on the chart, e.g. "click where z = 0.5 − j1 is", "click where y = 1 + j0 is", or "click where a shunt C of 2 pF takes the load". The app computes the exact spot and grades the click by distance; you get the result and both points. Great for reading the chart and predicting moves.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Written to the learner' },
        point: { ...POINT, description: 'The spot to find: {r, x} or {g, b}. Or give element (+ from) instead.' },
        element: { ...ELEMENT, description: 'Find where this element takes the point (starting at from / from_point)' },
        ...FROM,
        tolerance: { type: 'number', description: 'Allowed distance in Γ (default 0.06; the chart radius is 1)' },
        title: { type: 'string', description: 'Short name for the lesson record' },
        skill: { type: 'string' }
      },
      required: ['question']
    },
    activity: () => 'Asking you to find a spot',
    endsTurn: true,
    run(a, ctx) {
      const s = ctx.studio
      const f = s.designFreq
      let z = normPoint(a.point)
      let what = z ? (typeof a.point?.g === 'number' ? `y = ${fmtNorm(admittanceOf(z))}` : `z = ${fmtNorm(z)}`) : ''
      let graded = z ? (typeof a.point?.g === 'number' ? classifyLocate('y') : classifyLocate('z', onMajor(z))) : undefined
      if (!z && a.element) {
        const el = parseElement(a.element, f, s.z0)
        graded = classifyLocate(el.kind)
        const { Z, what: from } = startZ(a, ctx, f)
        const Z2 = applyElement(Z, el, f)
        z = c(Z2.re / s.z0, Z2.im / s.z0)
        what = `where a ${ELEMENT_LABEL[el.kind]} of ${valueText(el.kind, el.value)} takes ${from}: z = ${fmtNorm(z)}`
      }
      if (!z) throw new Error('Give "point" ({r, x} or {g, b}) or "element" (with optional "from").')
      if (!insideChart(z)) throw new Error('That spot is off the chart (or at the open/short): pick another.')
      graded = inSituation(graded!, `${regionOf(z)}, ${a.element ? 'after an element' : typeof a.point?.g === 'number' ? 'given as y' : 'given as z'}`)
      const tol = Number.isFinite(a.tolerance) && a.tolerance > 0 ? Math.min(a.tolerance, 0.3) : 0.06
      const targetText = `${what} (y = ${fmtNorm(admittanceOf(z))})`
      s.setPrediction({
        id: uid('q'), question: String(a.question), kind: 'click', title: a.title ?? short(String(a.question)), skill: a.skill,
        key: { type: 'locate', target: gammaFromZ(z, 1), tol, targetText }, graded
      })
      return `Question card shown; the learner will click on the chart. The answer is ${targetText} (don't reveal it). The app grades the click and tells you how far off it is.${remember(ctx, graded!, 'locate', String(a.question))}`
    }
  },
  {
    name: 'ask_move',
    description: 'Graded multiple-choice question on how ONE element moves the point: which way it turns and along which circle (ask "path"), or which half of the chart it ends in (ask "end_half", needs a value). The app builds the choices and works out the right one with the move calculator, so you never have to state the direction yourself. Ideal before the learner adds an element (predict, then try it).',
    parameters: {
      type: 'object',
      properties: {
        element: ELEMENT,
        ...FROM,
        ask: { type: 'string', enum: ['path', 'end_half'], description: 'Default "path"' },
        with_reason: { type: 'boolean', description: 'path only. Default true: after the direction they also pick WHY (what the element adds), from reasons the app builds; a right direction for the wrong reason counts as partly right and shows the wrong idea. Set false only for a quick warm-up.' },
        question: { type: 'string', description: 'Optional wording; default asks how the element moves the point' },
        title: { type: 'string' },
        skill: { type: 'string' }
      },
      required: ['element']
    },
    activity: () => 'Asking how a move goes',
    endsTurn: true,
    run(a, ctx) {
      const s = ctx.studio
      const f = s.designFreq
      const ask = a.ask === 'end_half' ? 'end_half' : 'path'
      const raw = typeof a.element === 'string' ? { kind: a.element } : a.element
      if (ask === 'end_half' && !(Number.isFinite(raw?.value) && raw.value > 0)) throw new Error('For "end_half" give the element a value: where it ends depends on how big it is.')
      const el = parseElement(a.element, f, s.z0)
      const { Z, what } = startZ(a, ctx, f)
      if (!insideChart(c(Z.re / s.z0, Z.im / s.z0))) throw new Error('The starting point is off the chart.')
      const q = moveQuestion(Z, el, f, s.z0, ask)
      const withReason = ask === 'path' && a.with_reason !== false && !!q.reasons
      const sized = ask === 'end_half' ? ` of ${valueText(el.kind, el.value)}` : ''
      const question = a.question ? String(a.question)
        : ask === 'end_half' ? `If you add a ${ELEMENT_LABEL[el.kind]}${sized} to ${what}, where does the point end up?`
          : `If you add a ${ELEMENT_LABEL[el.kind]} to ${what}, how does the point move?`
      const graded = inSituation(classifyMove(el.kind, ask, withReason), `from the ${q.startHalf === 'on the real axis' ? 'real axis' : `${q.startHalf} half`}${ask === 'end_half' ? ', where it ends' : ''}`)
      s.setPrediction({
        id: uid('q'), question, kind: 'mcq', choices: q.choices, title: a.title ?? short(question), skill: a.skill,
        key: { type: 'move', choices: q.choices, correct: q.correct, facts: q.facts, ...(withReason ? { reasons: q.reasons } : {}) }, graded
      })
      const why = withReason ? ` Then they pick why: ${q.reasons!.choices.map((x, i) => `${i === q.reasons!.correct ? '[right] ' : ''}"${x}"`).join(', ')}.` : ''
      return `Question card shown with choices: ${q.choices.map((x, i) => `${i === q.correct ? '[right] ' : ''}"${x}"`).join(', ')}.${why} Verified move: ${q.facts}${remember(ctx, graded, 'move', question)} Wait for their answer; the app grades it.`
    }
  },
  {
    name: 'ask_value',
    description: 'Graded question: the learner reads or works out one number at a point (VSWR, return loss, |Γ|, angle of Γ, z, y, Z in Ω, Y in mS, Q, WTG). The app computes the exact value and grades their typed answer with a tolerance (default ±5%, with sensible minimums for small values).',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Written to the learner' },
        quantity: { type: 'string', enum: Object.keys(QUANTITIES) },
        ...FROM,
        tolerance_pct: { type: 'number', description: 'Default 5; 1–20' },
        title: { type: 'string' },
        skill: { type: 'string' }
      },
      required: ['question', 'quantity']
    },
    activity: () => 'Asking for a value',
    endsTurn: true,
    run(a, ctx) {
      const s = ctx.studio
      const quantity = a.quantity as Quantity
      if (!QUANTITIES[quantity]) throw new Error(`quantity must be one of ${Object.keys(QUANTITIES).join(', ')}.`)
      const { Z, what } = startZ({ from: a.from ?? a.of, from_point: a.from_point }, ctx, s.designFreq)
      const metrics = metricsFromZ(Z, s.z0, s.designFreq)
      if (quantity === 'gamma_angle_deg' && metrics.gammaMag < 0.02) throw new Error('At the centre (matched) Γ ≈ 0, so it has no angle: ask about another point or quantity.')
      const expected = expectedValue(metrics, quantity)
      const graded = inSituation(classifyValue(quantity), `${quantity}, ${regionOf(c(Z.re / s.z0, Z.im / s.z0))}`)
      const finite = typeof expected === 'number' ? Number.isFinite(expected) : isFiniteC(expected)
      if (!finite) throw new Error(`${QUANTITIES[quantity].label} is infinite or undefined at ${what}; ask about another point or quantity.`)
      const tolPct = Number.isFinite(a.tolerance_pct) ? Math.min(20, Math.max(1, a.tolerance_pct)) : 5
      s.setPrediction({
        id: uid('q'), question: String(a.question), kind: 'text', hint: QUANTITIES[quantity].hint, title: a.title ?? short(String(a.question)), skill: a.skill,
        key: { type: 'value', quantity, expected, tolPct, z0: s.z0 }, graded
      })
      const shown = typeof expected === 'number' ? expected.toFixed(3) : fmtNorm(expected)
      return `Question card shown. Exact ${QUANTITIES[quantity].label} at ${what}: ${shown} at ${fmtHz(s.designFreq)} (don't reveal it). The app grades their answer (±${tolPct}%) and tells you.${remember(ctx, graded, 'value', String(a.question))}`
    }
  },
  {
    name: 'ask_spot_error',
    description:
      'Graded question that is hard to bluff: the app writes a worked L-match for a load, step by step with the numbers, and plants one realistic mistake ' +
      '(an inverted normalisation, the wrong direction, the wrong circle, the wrong part for the sign, a forgotten 2π in a component value), or sometimes none. ' +
      'The learner picks the step with the mistake, or "No mistake". Use it to check understanding of a whole match rather than one fact, ' +
      'and to verify a skill that looks strong on thin evidence. You learn where the mistake is; don\'t reveal it.',
    parameters: {
      type: 'object',
      properties: {
        mistake: { type: 'string', enum: [...MISTAKES, 'any'], description: 'Which mistake to plant; default "any" (the app picks, and "none" comes up sometimes)' },
        from_point: { ...POINT, description: 'Optional: match this normalized load instead of the current one' },
        title: { type: 'string' }
      }
    },
    activity: () => 'Asking you to check a worked solution',
    endsTurn: true,
    run(a, ctx) {
      const s = ctx.studio
      const f = s.designFreq
      const p = normPoint(a.from_point)
      const ZL = p ? c(p.re * s.z0, p.im * s.z0) : loadImpedance(s.load, f, s.datasets)
      if (!insideChart(c(ZL.re / s.z0, ZL.im / s.z0)) || ZL.re <= 0) throw new Error('The load must be a passive point inside the chart.')
      const mistake: Mistake = (MISTAKES as readonly string[]).includes(a.mistake) ? a.mistake : MISTAKES[Math.floor(Math.random() * MISTAKES.length)]
      const q = spotQuestion(ZL, s.z0, f, mistake)
      const topic = q.topic as TopicId
      const graded = inSituation({ topic, skill: topicDef(topic)!.skill, difficulty: q.difficulty }, `spot the mistake: ${mistake}`)
      const question = q.body
      s.setPrediction({
        id: uid('q'), question, kind: 'mcq', choices: q.choices, title: a.title ?? 'Spot the mistake in a worked match',
        key: { type: 'pick', choices: q.choices, correct: q.correct, facts: q.facts, ideas: q.choices.map((_, i) => (i === 4 && q.missedIdea ? q.missedIdea : '')), missed: MISTAKE_CONFUSION[mistake] },
        graded
      })
      return `Question card shown: a worked match with ${mistake === 'none' ? 'NO mistake' : `a mistake in ${q.choices[q.correct]}`} (don't reveal it). ${q.facts}${remember(ctx, graded, 'spot', 'Spot the mistake')} Wait for their answer; the app grades it.`
    }
  },
  {
    name: 'ask_component',
    description:
      'Graded question on the step from the chart to a real part: which part (L or C) and what value adds a given normalised reactance x (series) or susceptance b (shunt) at the design frequency, ' +
      'or takes the point from one spot to another. The learner types the value with its unit ("2.7 nH", "1.1 pF"); the unit says which part they chose. ' +
      'The app computes the exact part and value, grades within a tolerance, and spots the classic slips (a forgotten 2π, not de-normalising, L and C swapped). Use it whenever a lesson needs real component values.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Written to the learner; say what to find, e.g. "What part, and what value, adds x = −1.2 in series at 2.4 GHz (Z0 = 50 Ω)?"' },
        connection: { type: 'string', enum: ['series', 'shunt'] },
        amount: { type: 'number', description: 'The normalised x (series) or b (shunt) to add, signed' },
        from_point: { ...POINT, description: 'Instead of amount: the start point ({r, x} or {g, b})' },
        to_point: { ...POINT, description: 'Instead of amount: where the part must take it' },
        tolerance_pct: { type: 'number', description: 'Default 5; 2–15' },
        title: { type: 'string' }
      },
      required: ['question', 'connection']
    },
    activity: () => 'Asking for a component value',
    endsTurn: true,
    run(a, ctx) {
      const s = ctx.studio
      const f = s.designFreq
      const conn = a.connection === 'shunt' ? 'shunt' : 'series'
      const p1 = normPoint(a.from_point), p2 = normPoint(a.to_point)
      const r = Number.isFinite(a.amount) && a.amount !== 0
        ? componentFor(conn, a.amount, true, f, s.z0)
        : p1 && p2 ? componentForMove(conn, p1, p2, f, s.z0) : null
      if (!r) throw new Error('Give "amount" (the normalised x or b to add) or both "from_point" and "to_point".')
      if (r.warning) throw new Error(`That can't be done with one ${conn} part: ${r.warning}`)
      if (!r.component) throw new Error('Nothing to add: the amount is zero.')
      const tolPct = Number.isFinite(a.tolerance_pct) ? Math.min(15, Math.max(2, a.tolerance_pct)) : 5
      const part = r.component.kind.endsWith('L') ? 'L' : 'C'
      const sign = r.component.kind.endsWith('L') === (conn === 'series') ? 'positive' : 'negative'
      const graded = inSituation({ topic: 'part_value', skill: 'l_match', difficulty: conn === 'series' ? 2 : 3 }, `${conn}, ${sign} ${conn === 'series' ? 'x' : 'b'}`)
      const working = r.steps.map((x) => x.label).join(' → ')
      s.setPrediction({
        id: uid('q'), question: String(a.question), kind: 'text', hint: 'value with its unit, e.g. 2.7 nH or 1.1 pF', title: a.title ?? short(String(a.question)),
        key: { type: 'component', part, value: r.component.value, tolPct, z0: s.z0, facts: `Exact: ${r.component.text} (${r.outputs.map((o) => `${o.label} ${o.text}`).join('; ')}).` },
        graded
      })
      return `Question card shown. Exact answer (don't reveal it): ${r.component.text}; the working: ${working}. The app grades their typed value (±${tolPct}%) and names the slip if it's a classic one.${remember(ctx, graded, 'component', String(a.question))} Wait for their answer.`
    }
  }
])
