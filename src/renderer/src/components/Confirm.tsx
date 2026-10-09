import { useEffect, useRef } from 'react'
import { create } from 'zustand'

/**
 * Yes/no questions in the app's own look. The browser's confirm() opens the system's dialog,
 * which is white whatever the app's theme.
 */

interface Ask {
  message: string
  ok: string
  danger?: boolean
  resolve(yes: boolean): void
}

const useConfirm = create<{ ask: Ask | null }>(() => ({ ask: null }))

/** Ask a yes/no question; resolves true for the confirm button, false for Cancel or Escape. */
export function confirmDialog(message: string, opts: { ok?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    // A question already open is answered "no" first, so its caller isn't left waiting.
    useConfirm.getState().ask?.resolve(false)
    useConfirm.setState({ ask: { message, ok: opts.ok ?? 'OK', danger: opts.danger, resolve } })
  })
}

export function ConfirmHost() {
  const ask = useConfirm((s) => s.ask)
  const okRef = useRef<HTMLButtonElement>(null)
  const answer = (yes: boolean) => {
    ask?.resolve(yes)
    useConfirm.setState({ ask: null })
  }
  useEffect(() => {
    if (!ask) return
    okRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') answer(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ask]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!ask) return null
  const [title, ...rest] = ask.message.split('\n\n')
  return (
    <div className="confirm-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) answer(false) }}>
      <div className="confirm-dialog card" role="alertdialog" aria-modal="true" aria-label={title}>
        <b>{title}</b>
        {rest.map((p, i) => <p key={i} className="small">{p}</p>)}
        <div className="row">
          <span className="spacer" />
          <button onClick={() => answer(false)}>Cancel</button>
          <button ref={okRef} className={ask.danger ? 'danger' : 'primary'} onClick={() => answer(true)}>{ask.ok}</button>
        </div>
      </div>
    </div>
  )
}
