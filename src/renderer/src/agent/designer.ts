import { create } from 'zustand'
import type { ChatMessage, ChatResult, Part } from '@shared/llm'
import { textOf } from '@shared/llm'
import type { NetworkElement } from '@shared/rf/network'
import { activeProvider, api, currentChartMode, registerBusy, useApp } from '@/state/app'
import { useStudio } from '@/state/studio'
import { computeDerived } from '@/state/derived'
import { fmtHz } from '@/lib/format'
import { callLLM, historyForModel, trimHistory, type DisplayItem } from './tutor'
import { runToolIn, specsOf, toolActivity } from './registry'
import { buildDesignPrompt } from './design/prompt'
import { designTools, partsText, type DesignContext, type Proposal } from './design/tools'
import type { AgentTool } from './types'

/**
 * The Design tab's assistant: matches the user's own loads with them, like a colleague.
 * Same chart tools and models as the tutor, but it does the work, and nothing it does
 * is graded or counted in their learning record.
 */

const MAX_STEPS = 10
const MAX_HISTORY = 60
const MAX_ITEMS = 600

const TOOLS: AgentTool[] = designTools()
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))
const READ_ONLY = new Set(['get_chart_state', 'rf_calculate', 'what_if', 'analyze_sweep', 'match_options', 'check_network'])

interface DesignChat {
  v: 1
  items: DisplayItem[]
  history: ChatMessage[]
  proposal: Proposal | null
  usage: { input: number; output: number }
  savedAt: string
}

interface DesignerState {
  profileId: string | null
  items: DisplayItem[]
  history: ChatMessage[]
  busy: boolean
  requestId: string | null
  usage: { input: number; output: number }
  /** The design cards on screen */
  proposal: Proposal | null
  /** The network before the last Apply, for Undo */
  undo: NetworkElement[] | null
  send(text: string): Promise<void>
  stop(): void
  /** Put a proposed design on the chart; returns what happened, for the assistant */
  apply(option: number): string
  undoApply(): void
  /** Start a new conversation (the chart stays as it is) */
  clear(): void
}

let seq = 0
/** The assistant's tool context (set when the store is made), for the test harness. */
let designCtx: DesignContext | null = null

/** Run one of the design assistant's tools directly (test harness). */
export const runDesignTool = (name: string, args: Record<string, unknown>) => runToolIn(BY_NAME, name, args, designCtx!, '')
const iid = () => `d${Date.now().toString(36)}${seq++}`

const FRESH = () => ({
  items: [] as DisplayItem[],
  history: [] as ChatMessage[],
  busy: false,
  requestId: null,
  usage: { input: 0, output: 0 },
  proposal: null,
  undo: null
})

/** The option number in "apply 2", "ok, use option 1", "go with #3"; 0 when it isn't plainly a request to apply one. */
export function applyRequest(text: string, count: number, recommended = 0): number {
  const t = text.toLowerCase()
  if (!count || /\b(don'?t|not|why|what if|how|compare|instead of)\b|\?/.test(t)) return 0
  if (recommended && /\b(?:apply|use|go with|put on)\b.{0,24}\b(?:recommend(?:ed)?|your pick|best one)\b/.test(t)) return recommended
  const m = /\b(?:apply|use|go with|put on)\b[^.\d]{0,24}?(?:option|design|#|number|no\.?)?\s*(\d)\b/.exec(t)
  const n = m ? Number(m[1]) : 0
  return n >= 1 && n <= count ? n : 0
}

export const useDesigner = create<DesignerState>((set, get) => {
  const pushItem = (it: Omit<DisplayItem, 'id'>) => {
    const item = { ...it, id: iid() }
    const items = get().items
    set({ items: items.length >= MAX_ITEMS ? [...items.slice(-(MAX_ITEMS - 100)), item] : [...items, item] })
    return item.id
  }
  const patchItem = (id: string, fn: (i: DisplayItem) => DisplayItem) => set({ items: get().items.map((i) => (i.id === id ? fn(i) : i)) })
  const removeItem = (id: string) => set({ items: get().items.filter((i) => i.id !== id) })

  let lastSeenEventAt = Date.now()

  const apply = (option: number): string => {
    const p = get().proposal
    const o = p?.options[option - 1]
    if (!p || !o) throw new Error(`There is no option ${option} on screen.`)
    // Only while the Design chart is loaded: never write a design onto a lesson's chart.
    if (currentChartMode() !== 'design') throw new Error('The Design chart is not open.')
    const st = useStudio.getState()
    set({ undo: st.network, proposal: { ...p, applied: option - 1 } })
    if (st.designFreq !== p.goal.f0) st.set('designFreq', p.goal.f0, `Design frequency set to ${fmtHz(p.goal.f0)} for the design`)
    st.set('network', o.elements.map((e) => ({ ...e })), `Applied design ${option} (${o.title}): ${partsText(o.elements)}`)
    // Show how the design gets there: the path from the load to the match, element by element.
    const ov = useStudio.getState().overlays
    if (!ov.showPath || !ov.showInputTrace) useStudio.getState().setOverlays({ showPath: true, showInputTrace: true })
    // A design for a band: show the band, so the numbers on the card can be seen on the chart.
    const band = p.goal.band
    if (band) {
      const cur = useStudio.getState()
      if (cur.sweep.start > band.low || cur.sweep.stop < band.high) {
        const pad = (band.high - band.low) * 0.5
        cur.set('sweep', { ...cur.sweep, start: Math.min(cur.sweep.start, band.low - pad), stop: Math.max(cur.sweep.stop, band.high + pad) })
      }
      if (!cur.markers.length) cur.set('markers', [band.low, band.high])
      cur.setShowBand(true, 'tutor', 'to show the band the design was made for')
    }
    return `Applied option ${option} (${o.title}) to the user's chart. They can undo it.`
  }

  const ctx: DesignContext = {
    get studio() { return useStudio.getState() },
    derived: () => computeDerived(useStudio.getState().snapshot()),
    profile: () => useApp.getState().profile!,
    // Nothing here touches the learning record.
    updateProfile: async () => {},
    learnerTurns: () => 0,
    recordExercise: () => {},
    session: () => null,
    updateSession: () => {},
    completeLesson: () => {},
    proposal: () => get().proposal,
    propose: (p) => set({ proposal: p, undo: null }),
    apply
  }
  designCtx = ctx

  async function runAgent() {
    const provider = activeProvider()
    const profile = useApp.getState().profile
    if (!provider || !profile) {
      pushItem({ kind: 'error', text: 'No model yet. Open the Models tab to set up the free local model or add a cloud one; the design assistant uses the same model as the tutor.' })
      return
    }
    if (provider.supportsTools === false) {
      pushItem({ kind: 'error', text: `${provider.label} can't use tools, and the design assistant needs them for every number. Pick another model at the top.` })
      return
    }
    const tools = specsOf(TOOLS)
    const counts = new Map<string, number>()
    const seen = new Map<string, string>()
    let nudged = false
    let shownThisTurn = false
    for (let step = 0; step < MAX_STEPS; step++) {
      const itemId = pushItem({ kind: 'tutor', text: '', streaming: true, model: provider.label })
      let res: ChatResult
      try {
        res = await callLLM(
          { providerId: provider.id, system: buildDesignPrompt(useApp.getState().profile ?? profile), messages: historyForModel(get().history), tools },
          (delta) => patchItem(itemId, (i) => ({ ...i, text: i.text + delta })),
          (requestId) => set({ requestId })
        )
      } catch (e) {
        removeItem(itemId)
        pushItem({ kind: 'error', text: (e as Error).message })
        return
      }
      const message = res.message
      const text = textOf(message)
      set({ usage: { input: get().usage.input + (res.usage.inputTokens ?? 0), output: get().usage.output + (res.usage.outputTokens ?? 0) } })
      if (text.trim()) patchItem(itemId, (i) => ({ ...i, text, streaming: false }))
      else removeItem(itemId)
      if (message.parts.length) set({ history: [...get().history, message] })

      const calls = message.parts.filter((p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call')
      if (!calls.length) {
        if (text.trim() || nudged) return
        nudged = true
        set({ history: [...get().history, { role: 'user', parts: [{ type: 'text', text: '[System] Please reply to the user now, in plain text.' }] }] })
        continue
      }
      const results: Part[] = []
      for (const call of calls) {
        const key = `${call.name}:${JSON.stringify(call.args)}`
        const prior = READ_ONLY.has(call.name) ? seen.get(key) : undefined
        if (prior !== undefined) {
          results.push({ type: 'tool_result', callId: call.id, name: call.name, content: `Same call already made this turn; result unchanged: ${prior}` })
          continue
        }
        const n = (counts.get(call.name) ?? 0) + 1
        counts.set(call.name, n)
        const toolItem = pushItem({ kind: 'tool', text: toolActivity(call.name, call.args, BY_NAME) + '…' })
        const r = n > 4
          ? { content: `You have called ${call.name} ${n} times this turn. Stop calling tools and reply to the user.`, isError: true }
          : call.name === 'propose_designs' && shownThisTurn
            ? { content: 'The cards are already on screen this turn. Reply to the user now: say which you recommend and why.', isError: true }
          : await runToolIn(BY_NAME, call.name, call.args, ctx, "(Note for you: don't mention this error to the user; fix the call or carry on.)")
        patchItem(toolItem, (i) => ({ ...i, text: toolActivity(call.name, call.args, BY_NAME) + (r.isError ? ' (skipped)' : '') }))
        results.push({ type: 'tool_result', callId: call.id, name: call.name, content: r.content, isError: r.isError })
        if (!r.isError && call.name === 'propose_designs') shownThisTurn = true
        if (!r.isError) {
          if (READ_ONLY.has(call.name)) seen.set(key, r.content.slice(0, 4000))
          else seen.clear()
        }
      }
      set({ history: [...get().history, { role: 'user', parts: results }] })
    }
    pushItem({ kind: 'system', text: 'The assistant took many steps in a row; paused here. Say something to continue.' })
  }

  return {
    profileId: null,
    ...FRESH(),

    async send(text) {
      if (get().busy || !text.trim()) return
      const events = useStudio.getState().eventsSince(lastSeenEventAt)
      const activity = events.length ? `\n\n[Chart activity since your last turn]\n${events.map((e) => `- ${e.text}`).join('\n')}` : ''
      lastSeenEventAt = Date.now()
      set({ busy: true })
      pushItem({ kind: 'user', text })
      // "Apply option 2": the app does it, so it happens even if a model only says it did.
      let applied = ''
      const prop = get().proposal
      const n = applyRequest(text, prop?.options.length ?? 0, (prop?.options.findIndex((o) => o.recommended) ?? -1) + 1)
      if (n) {
        try {
          applied = `\n\n[The app applied option ${n} to their chart, as they asked. Don't apply it again.]`
          pushItem({ kind: 'tool', text: get().apply(n).replace(/ to the user's chart.*/, '') })
        } catch { applied = '' }
      }
      const h = get().history
      const last = h[h.length - 1]
      const said: Part = { type: 'text', text: text + activity + applied }
      set({ history: last?.role === 'user' ? [...h.slice(0, -1), { ...last, parts: [...last.parts, said] }] : [...h, { role: 'user', parts: [said] }] })
      try {
        await runAgent()
      } finally {
        const hh = get().history
        set({ busy: false, requestId: null, ...(hh.length > MAX_HISTORY * 3 ? { history: trimHistory(hh, MAX_HISTORY * 2) } : {}) })
      }
    },

    stop() {
      const id = get().requestId
      if (id) api().llm.abort(id)
    },

    apply,

    undoApply() {
      const prev = get().undo
      const p = get().proposal
      if (!prev || currentChartMode() !== 'design') return
      useStudio.getState().set('network', prev, 'Undid the applied design')
      set({ undo: null, ...(p ? { proposal: { ...p, applied: undefined } } : {}) })
    },

    clear() {
      if (get().busy) return
      lastSeenEventAt = Date.now()
      set(FRESH())
    }
  }
})

registerBusy(() => useDesigner.getState().busy)

// ---- persistence: one design chat per profile -------------------------------

let saveTimer: ReturnType<typeof setTimeout> | undefined

function chatOf(s: DesignerState): DesignChat | null {
  if (!s.items.length && !s.history.length && !s.proposal) return null
  return {
    v: 1,
    items: s.items.filter((i) => !i.streaming || i.text).map((i) => ({ ...i, streaming: false })).slice(-300),
    history: trimHistory(s.history, MAX_HISTORY * 2),
    proposal: s.proposal,
    usage: s.usage,
    savedAt: new Date().toISOString()
  }
}

export function flushDesignChat() {
  clearTimeout(saveTimer)
  const s = useDesigner.getState()
  if (s.profileId) return api().design.save(s.profileId, 'chat', chatOf(s))
}

useDesigner.subscribe((s, prev) => {
  if (!s.profileId || s.profileId !== prev.profileId) return
  if (s.items === prev.items && s.history === prev.history && s.proposal === prev.proposal) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(flushDesignChat, 600)
})

async function loadChat(profileId: string) {
  const c = (await api().design.get(profileId, 'chat')) as DesignChat | null
  if (useApp.getState().profile?.id !== profileId) return
  if (!c || c.v !== 1) {
    useDesigner.setState({ profileId, ...FRESH() })
    return
  }
  useDesigner.setState({ profileId, ...FRESH(), items: c.items ?? [], history: c.history ?? [], proposal: c.proposal ?? null, usage: c.usage ?? { input: 0, output: 0 } })
}

useApp.subscribe((s, prev) => {
  const id = s.profile?.id ?? null
  if (id === (prev.profile?.id ?? null)) return
  const d = useDesigner.getState()
  if (d.busy) d.stop()
  if (d.profileId) flushDesignChat()
  useDesigner.setState({ profileId: null, ...FRESH() })
  if (id) loadChat(id).catch(console.error)
})

window.addEventListener('beforeunload', () => {
  flushDesignChat()
})
