import type { ReactNode } from 'react'
import { splitMath } from './mathText'
import { Tex } from './Tex'

export { plainMath } from './mathText'

/**
 * A model sometimes writes line breaks as the two characters "\n". Turn those into breaks, but
 * not LaTeX commands that start with \n (\nu, \nabla, \neq): only before a capital, a digit,
 * a space, another break or the end.
 */
export const unescapeBreaks = (t: string) => t.replace(/\\n(?=\\n|[A-Z0-9\s]|$)/g, '\n')

/** Tiny, safe markdown subset: paragraphs, bullet/numbered lists, **bold**, *italic*, `code`, ### headings, and formulas ($…$, $$…$$). */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  const lines = unescapeBreaks(text).replace(/\r/g, '').replace(/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]/g, (m) => m.replace(/\n/g, ' ')).split('\n')
  let list: { ordered: boolean; items: string[] } | null = null
  let para: string[] = []

  const flushPara = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{inline(para.join(' '))}</p>)
    para = []
  }
  const flushList = () => {
    if (!list) return
    const items = list.items.map((it, i) => <li key={i}>{inline(it)}</li>)
    blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>)
    list = null
  }

  for (const line of lines) {
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
    const num = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    const head = /^\s*#{1,4}\s+(.*)$/.exec(line)
    if (bullet || num) {
      flushPara()
      const ordered = !!num
      if (!list || list.ordered !== ordered) {
        flushList()
        list = { ordered, items: [] }
      }
      list.items.push((bullet ?? num)![1])
    } else if (head) {
      flushPara()
      flushList()
      blocks.push(<h5 key={blocks.length}>{inline(head[1])}</h5>)
    } else if (!line.trim()) {
      flushPara()
      flushList()
    } else {
      flushList()
      para.push(line.trim())
    }
  }
  flushPara()
  flushList()
  return <div className="md">{blocks}</div>
}

/**
 * Formulas are typeset; markdown applies around them. Formulas are swapped for
 * placeholders first, so emphasis can wrap one ("**$\Gamma$ vs VSWR:**") and their
 * own * and _ never read as emphasis.
 */
function inline(s: string): ReactNode[] {
  const parts = splitMath(s)
  const marked = parts.map((p, i) => (p.math === null ? p.text.replace(/[\u0001\u0002]/g, '') : `\u0001${i}\u0002`)).join('')
  const expand = (t: string, key: string): ReactNode[] =>
    t.split(/\u0001(\d+)\u0002/).flatMap((x, j): ReactNode[] => {
      if (j % 2 === 0) return x ? [x] : []
      const p = parts[Number(x)]
      return [<Tex key={`${key}m${x}`} tex={p.math!} block={p.block} />]
    })
  return prose(marked, expand)
}

function prose(s: string, expand: (t: string, key: string) => ReactNode[]): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(...expand(s.slice(last, m.index), `t${out.length}`))
    const t = m[0]
    const k = `e${out.length}`
    if (t.startsWith('**')) out.push(<b key={k}>{expand(t.slice(2, -2), k)}</b>)
    else if (t.startsWith('`')) out.push(<code key={k}>{expand(t.slice(1, -1), k)}</code>)
    else out.push(<i key={k}>{expand(t.slice(1, -1), k)}</i>)
    last = m.index + t.length
  }
  if (last < s.length) out.push(...expand(s.slice(last), `t${out.length}`))
  return out
}
