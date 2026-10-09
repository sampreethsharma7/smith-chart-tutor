import { useState } from 'react'
import { create } from 'zustand'
import type { ChatMessage } from '@shared/llm'
import { activeProvider, api, currentChartMode, useApp } from '@/state/app'
import { useStudio } from '@/state/studio'
import { useTutor } from '@/agent/tutor'
import { useDesigner } from '@/agent/designer'

/**
 * "Flag this": the person marks something that looks wrong (a reply, a card, the chart) and the
 * app saves a report to the reports folder, with everything needed to find the cause: the
 * conversation, the exact tool calls and results, the chart and a screenshot. Nothing is sent.
 */

type Source = { what: 'message'; agent: 'tutor' | 'design'; itemId: string } | { what: 'chart' }

interface FlagState {
  source: Source | null
  saved: string | null
  open(s: Source): void
  close(): void
}

export const useFlag = create<FlagState>((set) => ({
  source: null,
  saved: null,
  open: (source) => set({ source, saved: null }),
  close: () => set({ source: null, saved: null })
}))

const clip = (s: string, n = 3000) => (s.length > n ? `${s.slice(0, n)} […${s.length - n} more]` : s)

/** Recent history with tool calls and results, each part shortened. */
function historyExcerpt(h: ChatMessage[], n = 30) {
  return h.slice(-n).map((m) => ({
    role: m.role,
    parts: m.parts.map((p) => (p.type === 'text' ? { type: 'text', text: clip(p.text) } : p.type === 'tool_result' ? { ...p, content: clip(p.content) } : p))
  }))
}

/** Everything about the moment, for working out what went wrong. */
export function buildReport(source: Source, note: string) {
  const st = useStudio.getState()
  const agent = source.what === 'message' ? source.agent : currentChartMode() === 'design' ? 'design' : 'tutor'
  const chat = agent === 'design' ? useDesigner.getState() : useTutor.getState()
  const snap = st.snapshot()
  const flagged = source.what === 'message' ? chat.items.find((i) => i.id === source.itemId) : undefined
  return {
    v: 1,
    at: new Date().toISOString(),
    note: note.trim(),
    about: source.what === 'message' ? `a ${agent === 'design' ? 'design assistant' : 'tutor'} message` : `the chart (${agent === 'design' ? 'Design' : 'Learn'} tab)`,
    view: useApp.getState().view,
    activeModel: activeProvider()?.label,
    flaggedMessage: flagged ? { ...flagged, text: clip(flagged.text, 6000) } : undefined,
    recentChat: chat.items.slice(-40).map((i) => ({ kind: i.kind, text: clip(i.text, 1500), ...(i.model ? { model: i.model } : {}) })),
    history: historyExcerpt(chat.history),
    lesson: agent === 'tutor' ? { plan: useTutor.getState().session?.plan, focus: useTutor.getState().session?.focus } : undefined,
    proposal: agent === 'design' ? useDesigner.getState().proposal : undefined,
    chart: {
      ...snap,
      // Measured data can be large: its name and range say enough.
      datasets: snap.datasets.map((d) => ({ id: d.id, name: d.name, points: d.freqs.length, from: d.freqs[0], to: d.freqs[d.freqs.length - 1] })),
      view: st.view,
      tutorView: st.tutorView,
      recentEvents: st.events.slice(-20)
    }
  }
}

/** The ⚑ on a message. */
export function FlagButton({ agent, itemId }: { agent: 'tutor' | 'design'; itemId: string }) {
  return <button className="flag-btn" title="Flag a problem with this message" onClick={() => useFlag.getState().open({ what: 'message', agent, itemId })}>⚑</button>
}

/** The note box; on save it steps aside so the screenshot shows the app as it was. */
export function FlagDialog() {
  const source = useFlag((s) => s.source)
  const saved = useFlag((s) => s.saved)
  const [note, setNote] = useState('')
  const [hidden, setHidden] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!source || hidden) return null

  const save = async () => {
    setError(null)
    const report = buildReport(source, note)
    setHidden(true)
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    try {
      const name = await api().reports.save(report)
      useFlag.setState({ saved: name })
      setNote('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setHidden(false)
    }
  }

  return (
    <div className="flag-dialog card" role="dialog" aria-label="Flag a problem">
      {saved ? (
        <>
          <b>Report saved</b>
          <span className="small">It's in the reports folder on this PC, with a screenshot. Nothing was sent anywhere. To have it looked at, ask Claude Code to "check reports".</span>
          <div className="row">
            <button className="link" onClick={() => api().reports.openFolder()}>Open folder</button>
            <span className="spacer" />
            <button className="primary" onClick={() => useFlag.getState().close()}>Done</button>
          </div>
        </>
      ) : (
        <>
          <b>Flag a problem with {source.what === 'chart' ? 'the chart' : 'this message'}</b>
          <textarea autoFocus rows={3} value={note} placeholder="What looks wrong? (optional) e.g. says it drew a circle, but there's nothing" onChange={(e) => setNote(e.target.value)} />
          <span className="muted small">Saves the conversation, the tool calls, the chart and a screenshot to a folder on this PC. Nothing is sent.</span>
          {error && <span className="small bad">Couldn't save: {error}</span>}
          <div className="row">
            <span className="spacer" />
            <button onClick={() => useFlag.getState().close()}>Cancel</button>
            <button className="primary" onClick={save}>Save report</button>
          </div>
        </>
      )}
    </div>
  )
}
