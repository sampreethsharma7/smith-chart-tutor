/**
 * Patterns: the same confusion showing up again, in different topics and lessons.
 *
 * The app knows every right answer exactly, so it can tell precisely HOW an answer is
 * wrong (a click mirrored through the centre is the admittance point, a value off by 2π
 * forgot the 2π…). Each wrong answer that shows a known confusion leaves a slip; a
 * confusion seen in two topics or two lessons is a pattern. The tutor reasons about
 * patterns (names them, plans around the root cause); the app only detects and keeps
 * the record, so it is exact and the same whatever model teaches.
 */
import { abs, c, conj, inv, sub, type Complex } from './rf/complex'
import { gammaFromZ } from './rf/metrics'
import { parseComplex, parseNumber, parsePartValue, type QuestionKey } from './rf/tasks'
import { topicDef, type TopicId, type TopicStat } from './memory'
import type { Profile } from './profile'

export const CONFUSIONS = {
  z_vs_y: {
    name: 'Mixes up impedance and admittance (z and y)',
    root: 'y = 1/z is the same point turned 180° about the centre; series parts work on z (constant-r), shunt parts on y (constant-g).',
    probe: 'ask_locate a y point (point {g, b}) in a half they haven\'t done, and ask_move a shunt part with its reason',
    topics: ['plot_y', 'read_y', 'dir_shuntL', 'dir_shuntC', 'land_lumped']
  },
  series_vs_shunt: {
    name: 'Mixes up which circle a series or shunt part follows',
    root: 'A series part adds reactance, so r stays fixed (constant-r circle); a shunt part adds susceptance, so g stays fixed (constant-g circle).',
    probe: 'ask_move for one series and one shunt part from the same point, with reasons',
    topics: ['dir_seriesL', 'dir_seriesC', 'dir_shuntL', 'dir_shuntC', 'land_lumped']
  },
  rotation_sense: {
    name: 'Turns the point the wrong way',
    root: 'Adding +jx (series L) or +jb (shunt C) turns clockwise; −jx (series C) or −jb (shunt L) counter-clockwise.',
    probe: 'ask_move with reasons for the part they turned the wrong way, from the other half of the chart',
    topics: ['dir_seriesL', 'dir_seriesC', 'dir_shuntL', 'dir_shuntC']
  },
  reactance_sign: {
    name: 'Gets the sign of reactance or susceptance wrong (upper vs lower half, L vs C)',
    root: 'Upper half: x > 0 (inductive), b < 0. Lower half: x < 0 (capacitive), b > 0. A part adds its own sign.',
    probe: 'ask_locate a point in the lower half, and ask_value z for a capacitive load',
    topics: ['plot_z', 'read_z', 'land_lumped', 'gamma_angle']
  },
  normalisation: {
    name: 'Normalises the wrong way, or not at all',
    root: 'z = Z/Z0 (and Y in siemens is y/Z0); the chart only ever shows normalised values.',
    probe: 'ask_value Z_ohm and z for the same point, and ask_spot_error with mistake "normalise"',
    topics: ['read_z', 'plot_z', 'l_match']
  },
  two_pi: {
    name: 'Forgets the 2π (uses f where ω belongs)',
    root: 'ω = 2πf: X = ωL, B = ωC. A value off by about 6.3× is the tell-tale.',
    probe: 'ask_component for a series and a shunt part, then ask_spot_error with mistake "formula"',
    topics: ['l_match', 'l_match_tight', 'part_value']
  },
  gamma_vs_vswr: {
    name: 'Mixes up |Γ|, VSWR and return loss',
    root: '|Γ| is the distance from the centre (0–1); VSWR = (1 + |Γ|)/(1 − |Γ|) (≥ 1); return loss = −20 log|Γ| (positive dB).',
    probe: 'ask_value for each of the three at one point, in that order',
    topics: ['gamma_vswr']
  },
  angle_units: {
    name: 'Gives the angle of Γ in the wrong units',
    root: 'The rim of the chart is marked in degrees of Γ; −180° to 180°.',
    probe: 'ask_value gamma_angle_deg at a point in each half',
    topics: ['gamma_angle']
  },
  line_direction: {
    name: 'Turns the wrong way along a line (generator vs load)',
    root: 'Toward the generator is clockwise (WTG grows); toward the load is counter-clockwise.',
    probe: 'ask_move a line with its reason, and ask_value wtg_lambda',
    topics: ['dir_line', 'land_line', 'wtg']
  },
  line_motion: {
    name: 'Moves a line like a lumped part (along an r or g circle)',
    root: 'A matched line keeps |Γ|: the point turns around the chart centre, on its VSWR circle.',
    probe: 'ask_move a line, then ask_locate where it lands',
    topics: ['dir_line', 'land_line']
  },
  r_x_swap: {
    name: 'Reads r and x the wrong way round',
    root: 'r is the circle through the right-hand side; x is the arc that meets the rim.',
    probe: 'ask_locate a z with r ≠ x on a grid line, then off it',
    topics: ['plot_z', 'read_z']
  }
} as const satisfies Record<string, { name: string; root: string; probe: string; topics: readonly TopicId[] }>

export type Confusion = keyof typeof CONFUSIONS
export const CONFUSION_IDS = Object.keys(CONFUSIONS) as Confusion[]

/** One wrong answer that showed a confusion. Kept for good (bounded), so patterns can span months. */
export interface Slip {
  at: string
  session: string
  confusion: Confusion
  topic?: TopicId
  ctx?: string
  /** What exactly they did, in words ("clicked the y point, mirrored through the centre") */
  detail: string
  /** graded = detected by the app from an answer; tutor = noticed by the tutor in conversation */
  source: 'graded' | 'tutor'
}

/** What a wrong answer shows, before it is stamped with time and place. */
export interface SlipFinding { confusion: Confusion; detail: string }

// ── Telling HOW an answer is wrong ──────────────────────────────────────────

/** A spot-the-mistake question: the confusion behind each planted mistake (missed = accepted it). */
export const MISTAKE_CONFUSION: Record<string, Confusion | undefined> = {
  normalise: 'normalisation', direction: 'rotation_sense', circle: 'series_vs_shunt', element: 'reactance_sign', formula: 'two_pi', none: undefined
}

/** Close enough to say "that's what they computed": 5 %, or an absolute floor. */
const near = (a: number, b: number, floor = 0.02) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(0.05 * Math.abs(b), floor)
const nearC = (a: Complex, b: Complex, floor = 0.05) => abs(sub(a, b)) <= Math.max(0.06 * abs(b), floor)

/**
 * What a wrong (or right-for-the-wrong-reason) answer shows, if it shows a known confusion.
 * Empty when it is just imprecise or not recognisable: no guessing.
 */
export function slipsFor(key: QuestionKey, ans: { choice?: string; reason?: string; text?: string; gamma?: Complex }): SlipFinding[] {
  const out: SlipFinding[] = []
  if (key.type === 'move') {
    const i = key.choices.indexOf(ans.choice ?? '')
    const line = /around the chart centre/.test(key.choices[0])
    const endHalf = /^It ends/.test(key.choices[0])
    if (i >= 0 && i !== key.correct) {
      const axis = /real axis/.test(key.choices[i]) || /real axis/.test(key.choices[key.correct])
      if (endHalf && !axis) out.push({ confusion: 'reactance_sign', detail: `said the point ends "${key.choices[i].replace(/^It ends /, '')}" (it ends ${key.choices[key.correct].replace(/^It ends /, '')})` })
      else if (endHalf) { /* to or from the real axis: a size question, not a sign confusion */ }
      else if (line && i >= 2) out.push({ confusion: 'line_motion', detail: `moved a line along a ${i === 2 ? 'constant-r' : 'constant-g'} circle` })
      else if (line) out.push({ confusion: 'line_direction', detail: `turned a line ${i === 0 ? 'clockwise' : 'counter-clockwise'} (the other way is right)` })
      else {
        const circleWrong = (i < 2) !== (key.correct < 2)
        const dirWrong = i % 2 !== key.correct % 2
        const part = key.facts.split(':')[0]
        if (circleWrong) out.push({ confusion: 'series_vs_shunt', detail: `${part}: picked the ${i < 2 ? 'constant-r' : 'constant-g'} circle` })
        if (dirWrong) out.push({ confusion: 'rotation_sense', detail: `${part}: turned it ${i % 2 === 0 ? 'clockwise' : 'counter-clockwise'}` })
      }
    }
    // The reason shows the idea behind it, even when the direction was right.
    const r = key.reasons
    const j = r ? r.choices.indexOf(ans.reason ?? '') : -1
    if (r?.ids && j >= 0 && j !== r.correct) {
      const got = r.ids[j], want = r.ids[r.correct]
      const part = key.facts.split(':')[0]
      const kind = (id: string) => (id.startsWith('sx') ? 'series' : id.startsWith('pb') ? 'shunt' : 'line')
      const sign = (id: string) => (/up|gen/.test(id) ? '+' : '−')
      if (kind(got) === 'line' || kind(want) === 'line') {
        if (kind(got) !== kind(want)) out.push({ confusion: 'line_motion', detail: `${part}: reason "${r.choices[j]}"` })
        else out.push({ confusion: 'line_direction', detail: `${part}: reason "${r.choices[j]}"` })
      } else {
        if (kind(got) !== kind(want)) out.push({ confusion: 'series_vs_shunt', detail: `${part}: reason "${r.choices[j]}"` })
        if (sign(got) !== sign(want)) out.push({ confusion: 'reactance_sign', detail: `${part}: reason "${r.choices[j]}"` })
      }
    }
    return dedupe(out)
  }

  if (key.type === 'pick') {
    const i = key.choices.indexOf(ans.choice ?? '')
    const missed = key.missed as Confusion | undefined
    // They said "no mistake" (or picked the wrong step) when a mistake was planted: they accepted it.
    if (i >= 0 && i !== key.correct && missed) out.push({ confusion: missed, detail: `missed a planted mistake (${CONFUSIONS[missed].name.toLowerCase()}) in a worked match` })
    return out
  }

  if (key.type === 'component') {
    const g = parsePartValue(ans.text ?? '')
    if (!g) return out
    const part = g.unit === 'H' ? 'L' : 'C'
    const v = key.value
    if (part !== key.part) out.push({ confusion: 'reactance_sign', detail: `chose ${part === 'L' ? 'an inductor' : 'a capacitor'} where ${key.part === 'L' ? 'an inductor' : 'a capacitor'} was needed` })
    if (near(g.value, v * 2 * Math.PI, 0) || near(g.value, v / (2 * Math.PI), 0)) out.push({ confusion: 'two_pi', detail: `got a value off by 2π (${part === 'L' ? 'L' : 'C'} = ${g.value.toExponential(2)})` })
    else if (near(g.value, v * key.z0, 0) || near(g.value, v / key.z0, 0) || near(g.value, v * key.z0 * key.z0, 0) || near(g.value, v / (key.z0 * key.z0), 0)) {
      out.push({ confusion: 'normalisation', detail: `got a value off by Z0 (didn't de-normalise x or b)` })
    }
    return dedupe(out)
  }

  if (key.type === 'locate') {
    const g = ans.gamma
    if (!g || abs(sub(g, key.target)) <= key.tol) return out
    const t = key.target
    const tol = Math.max(key.tol * 1.5, 0.05)
    const zt = zOf(t)
    if (abs(sub(g, c(-t.re, -t.im))) <= tol) out.push({ confusion: 'z_vs_y', detail: 'clicked the point mirrored through the centre (the admittance point)' })
    else if (abs(sub(g, conj(t))) <= tol && Math.abs(t.im) > tol) out.push({ confusion: 'reactance_sign', detail: 'clicked the point in the other half (sign of the reactance flipped)' })
    else if (Number.isFinite(zt.re) && zt.im > 0.05 && Math.abs(zt.re - zt.im) > 0.15 && abs(sub(g, gammaFromZ(c(zt.im, zt.re), 1))) <= tol) {
      out.push({ confusion: 'r_x_swap', detail: `clicked z = ${r2(zt.im)} + j${r2(zt.re)}: r and x swapped` })
    }
    return out
  }

  // A typed value: compare with what the usual wrong calculations would give.
  const text = ans.text ?? ''
  const q = key.quantity
  if (typeof key.expected === 'number') {
    const n = parseNumber(text, q === 'gamma_angle_deg')
    if (n === null) return out
    const e = key.expected
    const vswr = q === 'vswr' ? e : NaN
    const gmag = q === 'gamma_mag' ? e : q === 'vswr' ? (e - 1) / (e + 1) : NaN
    if (q === 'vswr' && (near(n, gmag) || near(n, -20 * Math.log10(gmag), 0.3))) out.push({ confusion: 'gamma_vs_vswr', detail: `gave ${n} for VSWR ${r2(e)} (that is ${near(n, gmag) ? '|Γ|' : 'the return loss'})` })
    if (q === 'gamma_mag' && n > 1 && near(n, (1 + e) / (1 - e))) out.push({ confusion: 'gamma_vs_vswr', detail: `gave ${n} for |Γ| = ${r2(e)} (that is the VSWR)` })
    if (q === 'return_loss_db' && (near(n, -e, 0.3))) out.push({ confusion: 'gamma_vs_vswr', detail: `gave ${n} dB for a return loss of ${r2(e)} dB (sign flipped)` })
    if (q === 'return_loss_db' && n < 1 && near(n, Math.pow(10, -e / 20))) out.push({ confusion: 'gamma_vs_vswr', detail: `gave ${n} for a return loss of ${r2(e)} dB (that is |Γ|)` })
    if (q === 'gamma_angle_deg' && Math.abs(e) > 10 && near(n, (e * Math.PI) / 180, 0.05)) out.push({ confusion: 'angle_units', detail: `gave ${n} for an angle of ${r2(e)}° (radians)` })
    if (q === 'gamma_angle_deg' && Math.abs(e) > 10 && Math.abs(Math.abs(e) - 180) > 10 && near(n, -e, 4)) out.push({ confusion: 'reactance_sign', detail: `gave ${n}° for an angle of ${r2(e)}° (other half)` })
    if (q === 'wtg_lambda' && near(n, (0.5 - e) % 0.5, 0.008) && !near(e, 0.25, 0.01)) out.push({ confusion: 'line_direction', detail: `gave ${n} λ toward the generator (that is toward the load)` })
    void vswr
    return out
  }
  const z = parseComplex(text)
  if (!z) return out
  const e = key.expected
  const z0 = key.z0
  const as = (v: Complex, what: string, confusion: Confusion) => nearC(z, v) && out.push({ confusion, detail: `gave ${fmt(z)} for ${what} ${fmt(e)}` })
  if (q === 'z') {
    as(inv(e), 'z =', 'z_vs_y') || as(conj(e), 'z =', 'reactance_sign') || as(c(e.re * z0, e.im * z0), 'z =', 'normalisation') || (e.im > 0.05 && Math.abs(e.re - e.im) > 0.15 && as(c(e.im, e.re), 'z =', 'r_x_swap'))
  } else if (q === 'y') {
    as(inv(e), 'y =', 'z_vs_y') || as(conj(e), 'y =', 'reactance_sign')
  } else if (q === 'Z_ohm') {
    as(c(e.re / z0, e.im / z0), 'Z =', 'normalisation') || as(conj(e), 'Z =', 'reactance_sign')
  } else if (q === 'Y_mS') {
    as(c(e.re * z0 / 1000, e.im * z0 / 1000), 'Y (mS) =', 'normalisation') || as(conj(e), 'Y (mS) =', 'reactance_sign')
  }
  return out
}

const dedupe = (xs: SlipFinding[]) => xs.filter((x, i) => xs.findIndex((y) => y.confusion === x.confusion) === i)
const r2 = (v: number) => Math.round(v * 100) / 100
const fmt = (z: Complex) => `${r2(z.re)} ${z.im < 0 ? '−' : '+'} j${r2(Math.abs(z.im))}`
const zOf = (g: Complex): Complex => {
  const d = (1 - g.re) ** 2 + g.im ** 2
  return d === 0 ? c(Infinity, 0) : c((1 - g.re * g.re - g.im * g.im) / d, (2 * g.im) / d)
}

// ── Patterns: a confusion that keeps coming back ─────────────────────────────

export type PatternStatus = 'active' | 'fading' | 'gone'

export interface Pattern {
  confusion: Confusion
  name: string
  root: string
  probe: string
  status: PatternStatus
  slips: Slip[]
  topics: TopicId[]
  lessons: number
  lastSeen: string
  /** Lessons with clean right answers on its topics since it was last seen (2 = gone) */
  clearLessons: number
}

/**
 * A pattern is a confusion seen at least twice, in two different topics or two lessons
 * (once is a slip, not a pattern). It fades with clean right answers on its topics after
 * it was last seen, and is gone after two lessons of them; any new slip brings it back.
 * Derived from the record every time, so it can never drift out of date.
 */
export function patternsOf(p: Profile): Pattern[] {
  const slips = p.slips ?? []
  const out: Pattern[] = []
  for (const id of CONFUSION_IDS) {
    const mine = slips.filter((s) => s.confusion === id)
    if (mine.length < 2) continue
    const topics = [...new Set(mine.map((s) => s.topic).filter((t): t is TopicId => !!t))]
    const lessons = new Set(mine.map((s) => s.session)).size
    if (topics.length < 2 && lessons < 2) continue
    const def = CONFUSIONS[id]
    const lastSeen = mine.reduce((a, s) => (s.at > a ? s.at : a), '')
    const watch = new Set<TopicId>([...def.topics, ...topics])
    const slipLessons = new Set(mine.map((s) => s.session))
    const clean = [...watch].flatMap((t) => (p.topics?.[t] as TopicStat | undefined)?.rightIn ?? []).filter((e) => e.at > lastSeen && !slipLessons.has(e.session))
    const clearLessons = new Set(clean.map((e) => e.session)).size
    out.push({
      confusion: id, name: def.name, root: def.root, probe: def.probe,
      status: clearLessons >= 2 ? 'gone' : clearLessons === 1 ? 'fading' : 'active',
      slips: mine, topics, lessons, lastSeen, clearLessons
    })
  }
  const rank = { active: 0, fading: 1, gone: 2 }
  return out.sort((a, b) => rank[a.status] - rank[b.status] || b.slips.length - a.slips.length || b.lastSeen.localeCompare(a.lastSeen))
}

/** Add slips to the record (bounded: the oldest go first). */
export function addSlips(p: Profile, found: SlipFinding[], where: { at: string; session: string; topic?: TopicId; ctx?: string; source?: Slip['source'] }): Profile {
  if (!found.length) return p
  const slips = found.map((f) => ({ ...f, at: where.at, session: where.session, source: where.source ?? 'graded', ...(where.topic ? { topic: where.topic } : {}), ...(where.ctx ? { ctx: where.ctx } : {}) }))
  return { ...p, slips: [...(p.slips ?? []), ...slips].slice(-150) }
}

/** For the tutor: what a new answer did to the patterns (new pattern, or one coming back). */
export function patternNews(before: Profile, after: Profile): string[] {
  const was = new Map(patternsOf(before).map((x) => [x.confusion, x.status]))
  return patternsOf(after)
    .filter((x) => x.status === 'active' && was.get(x.confusion) !== 'active')
    .map((x) => `${was.has(x.confusion) ? 'PATTERN BACK' : 'NEW PATTERN'}: ${x.name}, seen ${x.slips.length}× in ${x.topics.length} topic(s) over ${x.lessons} lesson(s). Root idea: ${x.root} Name it to them kindly and work on the root, not the symptom.`)
}

/** Patterns, for the tutor's brief: active and fading ones, with the evidence and how to check. */
export function patternsBrief(p: Profile): string {
  const live = patternsOf(p).filter((x) => x.status !== 'gone').slice(0, 4)
  if (!live.length) return ''
  return `Patterns (the same confusion across topics or lessons; work on these first): ${live.map((x) =>
    `${x.confusion} [${x.status}${x.status === 'fading' ? ': one more lesson of clean answers clears it' : ''}] ${x.name}; seen ${x.slips.length}× (${x.slips.slice(-3).map((s) => `${s.topic ? topicDef(s.topic)?.name ?? s.topic : 'conversation'}: ${s.detail}`).join('; ')}). Check it with: ${x.probe}`
  ).join(' | ')}`
}
