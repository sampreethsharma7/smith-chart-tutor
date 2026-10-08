import { useEffect, useRef, useState } from 'react'
import { useDesigner } from '@/agent/designer'
import { useTutor } from '@/agent/tutor'
import { partsText, type DesignOption, type Proposal } from '@/agent/design/tools'
import { activeProvider } from '@/state/app'
import { useStudio } from '@/state/studio'
import { teachMeWhy } from '@/state/handoff'
import { fmtHz } from '@/lib/format'
import { Message, ResizeHandle } from './TutorPanel'

const STARTERS = [
  'Match my load at the design frequency',
  'Give me the widest-band match',
  'What does my load look like across the band?'
]

/** The Design tab's assistant: it matches the user's own load with them. Nothing here is graded. */
export function DesignPanel() {
  const items = useDesigner((s) => s.items)
  const busy = useDesigner((s) => s.busy)
  const usage = useDesigner((s) => s.usage)
  const proposal = useDesigner((s) => s.proposal)
  const tutorBusy = useTutor((s) => s.busy)
  const hasNetwork = useStudio((s) => s.network.length > 0)
  const { send, stop, clear } = useDesigner.getState()
  const provider = activeProvider()
  const [text, setText] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const aside = useRef<HTMLElement>(null)

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [items, proposal])

  const submit = (t = text.trim()) => {
    if (!t || busy) return
    setText('')
    send(t)
  }

  return (
    <aside className="tutor design" ref={aside}>
      <ResizeHandle aside={aside} />
      <header className="tutor-head">
        <div>
          <b>Design assistant</b> <span className="muted small">{provider ? provider.label : 'no model'}</span>
        </div>
        <div className="row">
          <button
            onClick={() => teachMeWhy()}
            disabled={busy || tutorBusy || !hasNetwork}
            title={hasNetwork ? 'Open a tutor lesson on this design, to understand why it works' : 'Put a design on the chart first'}
          >
            Teach me why
          </button>
          <button onClick={clear} disabled={busy || (!items.length && !proposal)} title="Start a new conversation (your chart stays as it is)">New chat</button>
        </div>
      </header>

      <div className="messages" ref={scroller}>
        {items.length === 0 && (
          <div className="design-intro">
            <p>Bring your own load (import a .s1p or CST file on the left, or set one up) and tell me what you need, for example <i>"match to 50 Ω at 2.45 GHz, VSWR under 2 from 2.4 to 2.5 GHz"</i>.</p>
            <p className="muted small">I work out the options, show their numbers, and you apply the one you want. This isn't a lesson: nothing here is graded or counted in your progress. Want to learn the method? Use <b>Teach me why</b>.</p>
            <div className="design-starters">
              {STARTERS.map((s) => <button key={s} onClick={() => submit(s)} disabled={busy || !provider}>{s}</button>)}
            </div>
          </div>
        )}
        {items.map((it) => <Message key={it.id} it={it} />)}
        {busy && !items.some((i) => i.streaming) && <div className="msg tutor"><span className="dots">thinking</span></div>}
      </div>

      {proposal && <Proposals p={proposal} busy={busy} />}

      <div className="composer">
        <textarea
          placeholder={busy ? 'Working…' : 'Describe what you need, or ask about an option…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          rows={3}
        />
        <div className="row">
          <span className="muted small">{usage.input + usage.output > 0 ? `${usage.input.toLocaleString()} in / ${usage.output.toLocaleString()} out tokens` : 'Enter to send · Shift+Enter for newline'}</span>
          <span className="spacer" />
          {busy ? <button onClick={stop}>Stop</button> : <button className="primary" onClick={() => submit()} disabled={!provider}>Send</button>}
        </div>
      </div>
    </aside>
  )
}

function Proposals({ p, busy }: { p: Proposal; busy: boolean }) {
  const undo = useDesigner((s) => s.undo)
  const [open, setOpen] = useState(true)
  const { goal } = p
  const target = `VSWR ≤ ${goal.vswrMax ?? 2}${goal.band ? ` over ${fmtHz(goal.band.low)}–${fmtHz(goal.band.high)}` : ` at ${fmtHz(goal.f0)}`}`
  return (
    <div className="card design-options">
      <div className="row">
        <b>Design options</b>
        <span className="muted small">{target} · ideal parts</span>
        <span className="spacer" />
        <button className="link" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</button>
      </div>
      {open && p.options.map((o, i) => <OptionCard key={i} o={o} n={i + 1} applied={p.applied === i} busy={busy} canUndo={!!undo && p.applied === i} />)}
    </div>
  )
}

function OptionCard({ o, n, applied, busy, canUndo }: { o: DesignOption; n: number; applied: boolean; busy: boolean; canUndo: boolean }) {
  const r = o.result
  const { apply, undoApply } = useDesigner.getState()
  return (
    <div className={`design-option ${o.recommended ? 'recommended' : ''} ${applied ? 'applied' : ''}`}>
      <div className="row">
        <b>{n}. {o.title}</b>
        {o.recommended && <span className="chip ok">recommended</span>}
        <span className="spacer" />
        {applied
          ? <>{canUndo && <button onClick={undoApply} disabled={busy}>Undo</button>}<span className="chip ok">applied</span></>
          : <button className="primary" onClick={() => apply(n)} disabled={busy} title="Replace the network on your chart with this one">Apply</button>}
      </div>
      <div className="small">{partsText(o.elements)}</div>
      <div className="muted small">
        VSWR {r.vswr.toFixed(2)} ({r.returnLossDb > 60 ? 'return loss over 60 dB' : `${r.returnLossDb.toFixed(1)} dB return loss`}) at the design frequency
        {r.band && <> · worst in band {r.band.worstVswr.toFixed(2)}{r.band.meets ? ' ✓' : ' (misses the target)'}</>}
        {r.bandwidth && <> · matched {fmtHz(r.bandwidth.low, 3)}–{fmtHz(r.bandwidth.high, 3)} ({(r.bandwidth.fractional * 100).toFixed(1)}%{r.bandwidth.clipped ? '+' : ''})</>}
      </div>
      {o.note && <div className="small">{o.note}</div>}
    </div>
  )
}
