import type { Complex } from '@shared/rf/complex'

const PREFIXES: Array<[number, string]> = [
  [1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f']
]

/** 2.2e-9, 'H' → "2.2 nH" */
export function fmtEng(v: number, unit = '', digits = 3): string {
  if (!Number.isFinite(v)) return v > 0 ? '∞' : v < 0 ? '−∞' : '—'
  if (v === 0) return `0 ${unit}`.trim()
  const a = Math.abs(v)
  const [mult, p] = PREFIXES.find(([m]) => a >= m * 0.9995) ?? PREFIXES[PREFIXES.length - 1]
  return `${Number((v / mult).toPrecision(digits))} ${p}${unit}`.trim()
}

export const fmtHz = (f: number, digits = 4) => fmtEng(f, 'Hz', digits)

const SUFFIX: Record<string, number> = {
  t: 1e12, g: 1e9, meg: 1e6, M: 1e6, k: 1e3, K: 1e3, m: 1e-3, u: 1e-6, µ: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15
}

/** "2.2n", "2.2 nH", "10pF", "2.45 GHz", "1e-9" → number (NaN if invalid) */
export function parseEng(s: string): number {
  // Strip a trailing unit (Hz, H, F, Ω, ohm, S, deg). "10f" is read as 10 F, not femto.
  const t = s.trim().replace(/\s+/g, '').replace(/(hz|ohms?|deg|°|[hfsΩω])$/i, '')
  const m = /^([-+]?\d*\.?\d+(?:e[-+]?\d+)?)(meg|[tgMkKmuµnpf])?$/i.exec(t)
  if (!m) return NaN
  const base = Number(m[1])
  if (!m[2]) return base
  const p = m[2]
  const key = p.toLowerCase() === 'meg' ? 'meg' : p === 'M' || p === 'm' ? p : p.toLowerCase()
  return base * (SUFFIX[key] ?? NaN)
}

export function fmtNum(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return v > 0 ? '∞' : v < 0 ? '−∞' : '—'
  const a = Math.abs(v)
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(digits - 1)
  return Number(v.toPrecision(digits)).toString()
}

export function fmtC(z: Complex, unit = '', digits = 3): string {
  if (!Number.isFinite(z.re) || !Number.isFinite(z.im)) return '∞ (open)'
  const sign = z.im < 0 ? '−' : '+'
  return `${fmtNum(z.re, digits)} ${sign} j${fmtNum(Math.abs(z.im), digits)}${unit ? ' ' + unit : ''}`
}

export const fmtDb = (v: number, digits = 2) => (Number.isFinite(v) ? `${v.toFixed(digits)} dB` : '∞ dB')
