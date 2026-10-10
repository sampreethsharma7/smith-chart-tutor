/**
 * No repeats: an item they have just answered right isn't asked again, and a task whose part values are
 * the ones they used in their last tasks isn't set. In the Riya re-run the same antenna's VSWR came up in
 * four lessons (answered from memory: "I remember it from last time"), the 100 + j50 Ω load in four, and
 * three tasks in a row needed 3.3 nH. An item is the thing asked, not its wording (course.ts itemSignature).
 * Asking again after a miss re-checks it, and a topic due for review may come back: both are allowed.
 */
import { lessonsOf, type Profile } from './profile'
import type { PartValue } from './rf/giveaway'

type Part = Omit<PartValue, 'text'>

/** How far back "just answered" reaches: this lesson and the two before it */
export const RECENT_LESSONS = 3

/** This lesson and the ones just before it. `current`: the lesson in progress (it may not be saved yet). */
function recentSessions(p: Profile, current?: string): Set<string> {
  const ids = lessonsOf(p).map((s) => s.id).filter((id) => id !== current)
  return new Set([...ids.slice(-(RECENT_LESSONS - 1)), ...(current ? [current] : [])])
}

/**
 * Whether this item (by its signature) was answered right in this lesson or a recent one, and isn't
 * now due for review. The newest answer to it decides: after a miss it may be asked again.
 */
export function repeatOf(p: Profile, sig: string, now: string, current?: string): { thisLesson: boolean } | null {
  const last = [...(p.answers ?? [])].reverse().find((a) => a.sig === sig)
  if (!last || last.outcome !== 'correct') return null
  if (!recentSessions(p, current).has(last.session)) return null
  const due = p.topics?.[last.topic]?.due
  if (due && due <= now && last.session !== current) return null
  return { thisLesson: last.session === current }
}

/** The refusal the tutor reads. */
export const repeatError = (r: { thisLesson: boolean }) =>
  `Already asked: they answered this exact item right ${r.thisLesson ? 'earlier this lesson' : 'in a recent lesson'}, so they'd answer from memory, not show the skill. ` +
  'Ask it in a new situation: another point, load, frequency or part (it may come back once they miss it, or when the topic is due for review).'

const near = (a: number, b: number) => Math.abs(a - b) <= 0.05 * Math.abs(b)

/**
 * The part values a new task would reuse: when every way to solve it (each solution's parts) uses only
 * values within 5% of those in their last two passed tasks, they could reuse a number instead of working
 * it out. Null when some solution needs a new value.
 */
export function reusedValues(p: Profile, solutions: Part[][], current?: string): Part[] | null {
  const recent = recentSessions(p, current)
  const used = [...(p.answers ?? [])].filter((a) => a.format === 'task' && a.outcome === 'correct' && a.parts?.length && recent.has(a.session)).slice(-2).flatMap((a) => a.parts!)
  const sols = solutions.filter((s) => s.length)
  if (!used.length || !sols.length) return null
  const reuses = (s: Part[]) => s.every((v) => used.some((u) => u.unit === v.unit && near(v.value, u.value)))
  return sols.every(reuses) ? sols[0] : null
}

const show = (v: Part) => (v.unit === 'deg' ? `${Number(v.value.toPrecision(3))}°` : v.unit === 'H' ? `${Number((v.value / 1e-9).toPrecision(3))} nH` : `${Number((v.value / 1e-12).toPrecision(3))} pF`)

export const reusedError = (vals: Part[]) =>
  `Not set: every way to solve it uses the same part values as their last tasks (${vals.map(show).join(', ')}), so they could reuse a number instead of working it out. ` +
  'Change the load, target or frequency so the values differ.'
