/**
 * Maths written as LaTeX ($z = 0.6 + j0.4$, \(y\), $$…$$). Formulas are typeset
 * (see Tex); these helpers find them, and turn one into plain text when it can't
 * be typeset.
 */

/** A formula as plain text: no delimiters, the few commands models use as symbols. */
export function tidyMath(m: string): string {
  const cmd: Record<string, string> = { Omega: 'Ω', Gamma: 'Γ', omega: 'ω', lambda: 'λ', approx: '≈', cdot: '·', times: '×', pm: '±', le: '≤', ge: '≥', infty: '∞', theta: 'θ', pi: 'π', to: '→', rightarrow: '→', angle: '∠', circ: '°', beta: 'β', ell: 'ℓ' }
  return m
    .replace(/\\(?:text|mathrm)\{([^}]*)\}/g, '$1')
    .replace(/\\([a-zA-Z]+)/g, (all, name: string) => cmd[name] ?? all)
    .replace(/\\[,;! ]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** All formulas in a text as plain text (kept for places that can't typeset). */
export function plainMath(text: string): string {
  return splitMath(text).map((p) => (p.math === null ? p.text : tidyMath(p.math))).join('')
}

export interface MathPart { text: string; math: string | null; block?: boolean }

/**
 * Split text into prose and formulas. "$…$" counts as a formula only when it hugs
 * its content ("$z = 1$", not "$5 and $10"), so prices stay prose.
 */
const MATH = /\$\$([^$]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\\w$])\$(?=[^\s$])([^$\n]*?[^\s$\\])\$(?!\d)/g
export function splitMath(text: string): MathPart[] {
  const out: MathPart[] = []
  let last = 0
  for (const m of text.matchAll(MATH)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index), math: null })
    const block = m[1] !== undefined || m[2] !== undefined
    out.push({ text: m[0], math: (m[1] ?? m[2] ?? m[3] ?? m[4]).trim(), block })
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), math: null })
  return out
}
