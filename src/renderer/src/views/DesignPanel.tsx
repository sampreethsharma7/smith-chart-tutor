import { useEffect, useRef, useState } from 'react'
import { useDesigner } from '@/agent/designer'
import { useTutor } from '@/agent/tutor'
import { cardPartsText, type DesignOption, type Proposal } from '@/agent/design/tools'
import type { NetworkElement } from '@shared/rf/network'
import { activeProvider, useApp } from '@/state/app'
import type { ProviderConfig } from '@shared/llm'
import { useStudio, valuesCovered } from '@/state/studio'
import { CoveredNote } from '@/panels/Readout'
import { teachMeWhy } from '@/state/handoff'
import { fmtHz } from '@/lib/format'
import { Message, ResizeHandle } from './TutorPanel'

const STARTERS = [
  'Match my load at the design frequency',
  'Give me the widest-band match',
  'What does my load look like across the band?'
]

/** A word of caution about the model, when its rating (or an unrated local model) suggests one. */
export function modelCaution(p: ProviderConfig | undefined, tier?: string): string | null {
  if (!p) return null
  if (tier && ['Usable', 'Limited', 'Failed'].includes(tier)) return `${p.label} is rated ${tier} on the Models page, so it may describe designs inaccurately.`
  const local = /localhost|127\.0\.0\.1/.test(p.baseUrl ?? '')
  if (!tier && local) return `${p.label} runs on this computer and hasn't been rated yet; small local models often describe designs inaccurately.`
  return null
}

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
  const bench = useApp((s) => (provider ? s.settings.benchmarks[provider.id] : undefined))
  const weak = modelCaution(provider, bench?.tier)
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
          <b>Design assistant</b> <span className="muted small">{provider ? provider.label : 'no model'}{bench && <span className={`tier tier-${bench.tier.toLowerCase()}`}>{bench.tier}</span>}</span>
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

      {weak && <div className="design-caution small">{weak} The numbers on the cards are always exact: the app computes them.</div>}
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
        {items.map((it) => <Message key={it.id} it={it} agent="design" />)}
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
  const network = useStudio((s) => s.network)
  const [open, setOpen] = useState(true)
  const { goal } = p
  const target = `VSWR ≤ ${goal.vswrMax ?? 2}${goal.band ? ` over ${fmtHz(goal.band.low)}–${fmtHz(goal.band.high)}` : ` at ${fmtHz(goal.f0)}`}`
  return (
    <div className="card design-options">
      <div className="design-options-head">
        <b>Design options</b>
        <span className="muted small" title="Ideal parts: no tolerance, loss or self-resonance">{target} · ideal parts</span>
        <span className="spacer" />
        <button className="link" onClick={() => setOpen(!open)}>{open ? 'Hide' : `Show ${p.options.length}`}</button>
      </div>
      {open && p.options.map((o, i) => {
        const applied = p.applied === i
        // Edited by hand since it was applied: Undo would throw those edits away, so it's no longer offered.
        const edited = applied && !sameNetwork(network, o.elements)
        return <OptionCard key={i} o={o} n={i + 1} goal={goal} fixedLoad={!!p.fixedLoad} applied={applied} edited={edited} busy={busy} canUndo={!!undo && applied && !edited} />
      })}
    </div>
  )
}

/** VSWR for a card: "∞" for a total mismatch rather than "Infinity". */
const vs = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '∞')

const sameNetwork = (a: NetworkElement[], b: NetworkElement[]) =>
  a.length === b.length && a.every((e, i) => e.kind === b[i].kind && Math.abs(e.value - b[i].value) <= 1e-9 * Math.abs(b[i].value))

function OptionCard({ o, n, goal, fixedLoad, applied, edited, busy, canUndo }: { o: DesignOption; n: number; goal: Proposal['goal']; fixedLoad: boolean; applied: boolean; edited: boolean; busy: boolean; canUndo: boolean }) {
  const r = o.result
  const { apply, undoApply } = useDesigner.getState()
  const bw = r.bandwidth
  const covered = useStudio(valuesCovered)
  return (
    <div className={`design-option ${o.recommended ? 'recommended' : ''} ${applied ? 'applied' : ''}`}>
      <div className="design-option-head">
        <b>{n}. {o.title}</b>
        <span className="design-option-actions">
          {applied && canUndo && <button onClick={undoApply} disabled={busy} title="Put back the network you had before">Undo</button>}
          {applied
            ? <span className="chip ok" title={edited ? 'You changed it on the chart after applying it' : undefined}>{edited ? 'applied, then edited' : 'applied'}</span>
            : <button className="primary" onClick={() => apply(n)} disabled={busy} title="Replace the network on your chart with this one">Apply</button>}
        </span>
      </div>
      {o.recommended && <span className="chip ok recommended-chip">recommended</span>}
      {/* The parts, unless the title already lists them */}
      {!o.title.replace(/\s/g, '').includes(cardPartsText(o.elements).replace(/\s/g, '')) && <div className="small">{cardPartsText(o.elements)}</div>}
      {covered ? <CoveredNote /> : <div className="design-metrics small">
        <span className="muted">At {fmtHz(goal.f0)}</span>
        <span>VSWR {vs(r.vswr)} · {r.returnLossDb > 60 ? 'RL over 60 dB' : `RL ${r.returnLossDb.toFixed(1)} dB`}</span>
        {r.band && <>
          <span className="muted">In band</span>
          <span className={r.band.meets ? 'good' : 'bad'}>worst VSWR {vs(r.band.worstVswr)} {r.band.meets ? '✓ meets it' : '✗ misses it'}</span>
        </>}
        <span className="muted">Matched</span>
        <span>{bw
          ? bw.clipped
            ? `${fmtHz(bw.low)}–${fmtHz(bw.high)} and beyond (the whole range checked)`
            : `${fmtHz(bw.low)}–${fmtHz(bw.high)} (${(bw.fractional * 100).toFixed(1)}%)`
          : 'not at the design frequency'}</span>
        {bw && fixedLoad && <><span /><span className="muted" title="A fixed impedance is the same at every frequency, so only the network limits the bandwidth here. Import measured data or use a load model for a real answer.">network only: your load is a fixed impedance, a real one would be narrower</span></>}
      </div>}
      {o.note && <div className="small">{o.note}</div>}
    </div>
  )
}
