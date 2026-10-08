import { useState, type ReactNode } from 'react'
import type { Sure } from '@shared/profile'

const ZONES: Sure[] = ['guess', 'unsure', 'sure']
const WORDS: Record<Sure, string> = { guess: 'guessing', unsure: 'not sure', sure: 'sure' }

/** Where on the button (0 = left edge, 1 = right edge) → which third: 0 guessing, 1 not sure, 2 sure. */
export const zoneOf = (fraction: number) => Math.min(2, Math.max(0, Math.floor(fraction * 3)))
export const sureAt = (fraction: number): Sure => ZONES[zoneOf(fraction)]

/**
 * An answer button that also says how sure you are, in the same click: further right
 * is surer (left third guessing, middle not sure, right third sure). A meter along the
 * bottom and a tag show the zone under the pointer. A keyboard press has no position,
 * so it gives no confidence (undefined), which the app treats as a plain answer.
 */
export function SureButton({ children, onPick, disabled, className = '' }: {
  children: ReactNode
  onPick(sure: Sure | undefined): void
  disabled?: boolean
  className?: string
}) {
  const [zone, setZone] = useState<number | null>(null)
  const zoneAt = (e: { clientX: number; currentTarget: HTMLElement }) => {
    const r = e.currentTarget.getBoundingClientRect()
    return zoneOf((e.clientX - r.left) / Math.max(1, r.width))
  }
  return (
    <button
      className={`sure-btn ${zone !== null ? `z${zone}` : ''} ${className}`}
      disabled={disabled}
      onMouseMove={(e) => setZone(zoneAt(e))}
      onMouseLeave={() => setZone(null)}
      // detail 0 = keyboard (Enter/Space): no position, so no confidence.
      onClick={(e) => onPick(e.detail === 0 ? undefined : ZONES[zoneAt(e)])}
      title="Click further right the surer you are: left guessing, middle not sure, right sure"
    >
      <span className="sb-label">{children}</span>
      {zone !== null && <span className="sb-tag">{WORDS[ZONES[zone]]}</span>}
      <span className="sb-meter" aria-hidden><i /><i /><i /></span>
    </button>
  )
}

/** The one-line key above a set of answer buttons. */
export function SureKey() {
  return (
    <div className="sure-key small muted" aria-hidden>
      <span>guessing</span>
      <span className="sk-bar"><i /><i /><i /></span>
      <span>sure</span>
      <span className="sk-hint">click further right the surer you are</span>
    </div>
  )
}
