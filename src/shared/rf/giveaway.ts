/**
 * The final task of a project is the learner's own work: the tutor may hint (which part, which way,
 * which circle) but not hand over the answer's part values. In a novice re-run a card said "a series
 * inductor of 2.28 nH is added" (the reference solution's first part), then a reply listed the whole
 * recipe. This finds such values in text, against the task's reference solutions.
 */
import type { NetworkElement } from './network'

export type PartUnit = 'H' | 'F' | 'deg'

export interface PartValue {
  value: number
  unit: PartUnit
  /** As written, e.g. "2.28 nH" */
  text: string
}

const PREFIX: Record<string, number> = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3, '': 1 }

/** Part values written in a text: "2.28 nH", "1,09 pF", "4.7nH", "45°" or "45 degrees". */
export function partValuesIn(text: string): PartValue[] {
  const s = text.replace(/(\d),(\d)/g, '$1.$2')
  const out: PartValue[] = []
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*([fpnuµμm]?)(H|F)\b/g)) {
    out.push({ value: Number(m[1]) * PREFIX[m[2]], unit: m[3] as 'H' | 'F', text: m[0] })
  }
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(°|deg\b|degrees?\b)/g)) out.push({ value: Number(m[1]), unit: 'deg', text: m[0] })
  return out
}

/** A network's part values in the same terms: L in H, C in F, lines and stubs in degrees (resistors have none here). */
export function partValuesOf(network: NetworkElement[]): Array<Omit<PartValue, 'text'>> {
  return network.flatMap((e): Array<Omit<PartValue, 'text'>> => (e.kind.endsWith('L') ? [{ value: e.value, unit: 'H' }]
    : e.kind.endsWith('C') ? [{ value: e.value, unit: 'F' }]
      : e.kind === 'tline' || e.kind.endsWith('Stub') ? [{ value: e.value, unit: 'deg' }] : []))
}

const near = (a: number, b: number, rel: number) => Math.abs(a - b) <= rel * Math.abs(b)

/**
 * The values in `text` that give away a reference part (within 10%), leaving out any the learner has
 * already put on the chart themselves (within 2%): talking about their own 2.28 nH is fine.
 */
export function giveaways(text: string, refs: Array<Omit<PartValue, 'text'>>, own: Array<Omit<PartValue, 'text'>> = []): string[] {
  if (!refs.length) return []
  return partValuesIn(text)
    .filter((v) => refs.some((r) => r.unit === v.unit && near(v.value, r.value, 0.1)))
    .filter((v) => !own.some((o) => o.unit === v.unit && near(v.value, o.value, 0.02)))
    .map((v) => v.text)
}

/** Told to the tutor when it named one: hint, don't hand over the answer. */
export const giveawayNudge = (found: string[]) =>
  `[System] Their project's final task is open, and your reply names ${found.length === 1 ? 'a part value' : 'part values'} of its solution (${[...new Set(found)].join(', ')}). ` +
  'This task is their own work: don\'t give its part values or a recipe. Rewrite it with a hint instead (which part, which way it moves the point, which circle to reach), or ask them a question that leads there; let them find the values on the chart.'
