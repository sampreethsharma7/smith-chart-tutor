import { useMemo } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { tidyMath } from './mathText'

/**
 * A formula, typeset (KaTeX, bundled: works offline). KaTeX escapes its input, so
 * the HTML is safe. A formula it can't read shows as tidy plain text instead.
 */
export function Tex({ tex, block = false }: { tex: string; block?: boolean }) {
  const html = useMemo(() => texHtml(tex, block), [tex, block])
  if (html === null) return <span className="tex-plain">{tidyMath(tex)}</span>
  return <span className={block ? 'tex block' : 'tex'} dangerouslySetInnerHTML={{ __html: html }} />
}

export function texHtml(tex: string, block = false): string | null {
  try {
    // A block formula is set in display style but in inline mode, so a long chain
    // (X = ωL ⇒ L = X/ω = 2.65 nH) wraps after an = instead of running off a narrow panel.
    return katex.renderToString(block ? `\\displaystyle ${tex}` : tex, { throwOnError: true, displayMode: false, output: 'html', strict: 'ignore' })
  } catch {
    return null
  }
}
