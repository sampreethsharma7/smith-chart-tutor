import { useEffect, useState } from 'react'
import { fmtEng, parseEng } from '@/lib/format'

interface Props {
  label?: string
  value: number
  unit?: string
  onCommit(v: number): void
  /** Format as engineering notation with this unit (e.g. "H", "Hz") */
  eng?: boolean
  min?: number
  title?: string
  width?: number
}

/** Text field that accepts engineering notation ("2.2n", "2.45 GHz") and commits on Enter/blur. */
export function NumField({ label, value, unit = '', onCommit, eng, min, title, width }: Props) {
  const show = () => (eng ? fmtEng(value, unit, 4) : `${Number(value.toPrecision(6))}`)
  const [text, setText] = useState(show)
  const [bad, setBad] = useState(false)
  useEffect(() => setText(show()), [value]) // eslint-disable-line react-hooks/exhaustive-deps

  const commit = () => {
    const v = parseEng(text)
    if (!Number.isFinite(v) || (min !== undefined && v < min)) {
      setBad(true)
      return
    }
    setBad(false)
    if (v !== value) onCommit(v)
    else setText(show())
  }

  return (
    <label className="numfield" title={title}>
      {label && <span>{label}</span>}
      <input
        className={bad ? 'bad' : ''}
        value={text}
        style={width ? { width } : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {!eng && unit && <em>{unit}</em>}
    </label>
  )
}
