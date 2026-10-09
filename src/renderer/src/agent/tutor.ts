import { create } from 'zustand'
import type { ChatMessage, ChatRequest, ChatResult, Part, StreamEvent } from '@shared/llm'
import { textOf } from '@shared/llm'
import { countsAsLesson, hasReviewMaterial, lessonsOf, masterySnapshot, skillName, type LessonFocus, type SessionRecord } from '@shared/profile'
import { probeTargets, skillStanding } from '@shared/standing'
import { activeProvider, api, registerBusy, useApp } from '@/state/app'
import { useStudio } from '@/state/studio'
import { useCalc } from '@/state/calc'
import { computeDerived } from '@/state/derived'
import { buildSystemPrompt } from './prompt'
import { COORDINATES_NUDGE, directionErrors, directionNudge, isMetaReply, isStageDirection, META_NUDGE, moveClaims, VERIFY_NUDGE } from './verify'
import { migrateLessonState } from '@shared/lesson'
import { endsTurn, runTool, toolActivity, toolSpecs, TOOLS } from './registry'
import { TurnAudit } from './issueLog'
import type { ToolContext } from './types'

export interface DisplayItem {
  id: string
  kind: 'user' | 'tutor' | 'tool' | 'error' | 'system'
  text: string
  streaming?: boolean
  /** Model that wrote a tutor message */
  model?: string
}

const MAX_STEPS = 12
const MAX_HISTORY = 60
/** Kept in memory (the chat panel draws only the latest; the saved file keeps 300) */
const MAX_ITEMS = 1000
/** One learner message or tool result, as the model sees it (the chat shows it in full) */
const MAX_PART_CHARS = 12000
/** Running lesson notes: digest the older transcript once this many new entries have built up, keeping the latest out of it */
const DIGEST_EVERY = 40
const DIGEST_KEEP = 24
/** A lesson's stored transcript: its latest messages, each shortened if huge (a pasted data file) */
const MAX_TRANSCRIPT = 2000
const MAX_ENTRY_CHARS = 4000
/** Lessons whose full transcript is kept; older summarised ones keep their last messages */
const FULL_TRANSCRIPTS = 20

/** Tools that put a question or task in front of the learner */
const ASKING_TOOLS = new Set(['ask_prediction', 'ask_locate', 'ask_move', 'ask_value', 'create_exercise', 'create_target_task'])

const FOLLOW_UP_NUDGE = "[System] The learner just solved the task and you haven't asked your follow-up yet. Ask ONE question about their own solution now (prefer ask_move, ask_locate or ask_value, built on their network), then stop and wait. Don't close the task or the lesson first."

/** One LLM call through the main process, streaming text to `onText`. */
export function callLLM(req: ChatRequest, onText?: (delta: string) => void, onStart?: (requestId: string) => void): Promise<ChatResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (ev: StreamEvent | undefined) => {
      if (settled || !ev) return
      if (ev.type === 'done') { settled = true; resolve(ev.result) }
      else if (ev.type === 'error') { settled = true; reject(new Error(ev.message)) }
    }
    const { requestId, done } = api().llm.chat(req, (ev) => {
      if (ev.type === 'text') onText?.(ev.delta)
      else finish(ev)
    })
    onStart?.(requestId)
    done.then((final) => {
      finish(final)
      if (!settled) reject(new Error('The request ended without a response.'))
    }, reject)
  })
}

export interface SendOptions {
  /** Internal instruction to the tutor (not something the learner said) */
  hidden?: boolean
  /** An action by the learner other than typing (prediction answer, exercise check) */
  learnerAction?: boolean
  /** What to show in the chat instead of the raw text sent to the model */
  display?: string
  /** The learner just solved a task: the tutor owes them one follow-up question this turn */
  followUp?: boolean
  /** Skills the app already updated from this graded answer (the tutor mustn't record them again) */
  autoRecorded?: string[]
}

/** What is saved per profile so a conversation survives restarts. */
interface Conversation {
  v: 1
  items: DisplayItem[]
  history: ChatMessage[]
  session: SessionRecord | null
  sessionStartedAt: number
  learnerTurns: number
  usage: { input: number; output: number }
  savedAt: string
}

interface TutorState {
  /** Profile whose conversation is loaded */
  profileId: string | null
  items: DisplayItem[]
  history: ChatMessage[]
  busy: boolean
  requestId: string | null
  session: SessionRecord | null
  sessionStartedAt: number
  lastSeenEventAt: number
  learnerTurns: number
  usage: { input: number; output: number }
  send(text: string, opts?: SendOptions): Promise<void>
  stop(): void
  /** Log a task or question outcome once per id (app-side, independent of the model) */
  logExercise(ex: { id: string; kind?: string; title: string; skill?: string; attempts: number }, passed: boolean): void
  /** A follow-up question on the learner's solution is owed this turn */
  followUpDue: boolean
  /** Skills recorded automatically for the answer this turn responds to */
  autoRecorded: string[]
  /** The lesson that just ended (shown as "Lesson complete" until the next one starts) */
  lastEnded: SessionRecord | null
  /** The tutor marked the goal reached; the lesson closes after its reply */
  completing: boolean
  /** One-off message for the lesson card (e.g. an empty lesson was discarded) */
  notice: string | null
  /** `design`: the learner came from the Design tab to understand that design (it's on the chart) */
  startSession(focus?: LessonFocus, design?: string): Promise<void>
  endSession(): Promise<void>
  reset(): void
}

let seq = 0
const iid = () => `it${Date.now().toString(36)}${seq++}`

export function trimHistory(h: ChatMessage[], max = MAX_HISTORY): ChatMessage[] {
  if (h.length <= max) return h
  // Start on a plain user turn so no tool result is orphaned from its call.
  for (let i = h.length - max; i < h.length; i++) {
    if (h[i].role === 'user' && !h[i].parts.some((p) => p.type === 'tool_result')) return h.slice(i)
  }
  // Every recent user turn carries tool results (a run of cards): start at the first user turn
  // anyway, keeping only its text, so the history still starts with the learner.
  const i = h.findIndex((m, k) => k >= h.length - max && m.role === 'user')
  if (i < 0) return h.slice(-max)
  const text = h[i].parts.filter((p) => p.type === 'text')
  return [{ role: 'user', parts: text.length ? text : [{ type: 'text', text: '[Earlier conversation trimmed]' }] }, ...h.slice(i + 1)]
}

/** A very long paste or tool result, shortened for the model (head and tail kept). */
function clip(s: string): string {
  if (s.length <= MAX_PART_CHARS) return s
  const keep = MAX_PART_CHARS / 2
  return `${s.slice(0, keep)}\n[… ${s.length - MAX_PART_CHARS} characters left out here. If this is measured data, the learner can import it as a file instead …]\n${s.slice(-keep)}`
}

/** What the model gets: the recent history, with oversized parts shortened. */
export function historyForModel(h: ChatMessage[]): ChatMessage[] {
  return trimHistory(h).map((m) =>
    m.parts.some((p) => (p.type === 'text' ? p.text.length : p.type === 'tool_result' ? p.content.length : 0) > MAX_PART_CHARS)
      ? { ...m, parts: m.parts.map((p) => (p.type === 'text' ? { ...p, text: clip(p.text) } : p.type === 'tool_result' ? { ...p, content: clip(p.content) } : p)) }
      : m
  )
}

/** Tools that only read: a repeat in the same turn can reuse the result unless something changed since. */
const READ_ONLY = new Set(['get_chart_state', 'rf_calculate', 'what_if', 'solve_l_match', 'analyze_sweep', 'get_learner_profile'])

/** Tool specs for a provider (always sent when history may contain tool calls: some APIs require it). */
const toolsFor = (supportsTools?: boolean) => (supportsTools === false ? undefined : toolSpecs())

const FRESH = () => ({
  items: [] as DisplayItem[],
  history: [] as ChatMessage[],
  session: null,
  busy: false,
  requestId: null,
  sessionStartedAt: Date.now(),
  lastSeenEventAt: Date.now(),
  learnerTurns: 0,
  usage: { input: 0, output: 0 },
  lastEnded: null,
  completing: false,
  notice: null,
  followUpDue: false,
  autoRecorded: [] as string[]
})

/**
 * Retrieval practice the learner opted into: one question on earlier material,
 * easy to skip, before the new goal.
 */
const REVIEW = ' Before the goal, ask ONE quick review question about something from an earlier lesson or an open misconception (one line, answerable in a few words). Whatever they answer, or if they skip it, give one line of feedback and move on to the goal; never turn it into a quiz.'

/** A "check yourself" session: verify, don't teach. */
function probeOpening(n: number): string {
  const p = useApp.getState().profile
  const targets = p ? probeTargets(skillStanding(p, new Date().toISOString())) : []
  const what = targets.length
    ? targets.map((r) => `${r.id} (${r.status}${r.proof.missing ? `; still needs ${r.proof.missing}` : ''})`).join(', ')
    : 'the skills they have practised (pick from their standing)'
  return `[Lesson ${n} start] Check-yourself session: the learner wants to find out what they really know. Verify, don't teach. ` +
    `Call set_lesson_goal (goal: "Check what holds in …", one step per skill), then ask 5–6 graded questions in a row, one at a time, on: ${what}. ` +
    'Use the hardest-to-bluff kinds: ask_move with its reason, ask_locate, ask_value, ask_spot_error, and one create_target_task. Put each in a situation they have not been right in before (other half of the chart, other side of r = 1, another quantity). ' +
    'Start at their aim level; after a clean right answer go one level up, after a miss one down. Give no hints or explanations unless they ask; between questions one short line only. ' +
    'At the end, tell them plainly what held and what didn\'t, from the results (not impressions), then set_next_focus and complete_lesson. Open now: one line saying what this is, then the first question.'
}

/** A lesson on a design the learner brought from the Design tab. */
export function designOpening(n: number, design: string): string {
  return `[Lesson ${n} start] The learner comes from the Design tab, where the design assistant matched their load with them. That design is on the chart now: ${design}. ` +
    'They want to understand why it works. Greet them in one line, call set_lesson_goal (the goal: understanding this design well enough to do it themselves; 2–3 steps), then start, building on their design: ' +
    'take it apart one element at a time, and have them predict each move before you show it.'
}

function lessonOpening(n: number, focus?: LessonFocus, review = false): string {
  if (focus === 'probe') return probeOpening(n)
  if (focus === 'own') {
    return `[Lesson ${n} start] The learner wants to bring their own question or design problem. Greet them in one line and ask what they're working on; once you know, call set_lesson_goal and start.`
  }
  const what = focus
    ? `The learner chose to work on: ${skillName(focus)} (${focus}).`
    : "Choose the focus yourself: start from your plan for what's next (in your instructions) unless something more urgent shows up (a review due, a live misconception, the last lesson summary). Without a plan yet, decide from their standing and placement test."
  return review
    ? `[Lesson ${n} start] ${what}${REVIEW} Open the lesson now: one-line greeting, then the review question, and wait for the answer. After it, call set_lesson_goal with the goal and its 2–3 steps and begin step 1.`
    : `[Lesson ${n} start] ${what} Open the lesson now: one-line greeting, set_lesson_goal with the goal and its 2–3 steps, then begin step 1 right away.`
}

/**
 * Summarise a session from its plain transcript. Sending no tool history makes
 * this work the same on every provider and every model size.
 */
async function summarizeTranscript(s: SessionRecord): Promise<string> {
  const provider = activeProvider()
  if (!provider) throw new Error('No model selected')
  // A long lesson: the running notes cover the start, the transcript the rest.
  const from = s.digest?.upTo ?? 0
  const lines = [
    ...(s.digest ? [`[Notes on the earlier part of the lesson] ${s.digest.text}`, '[The rest of the lesson]'] : []),
    ...s.transcript.slice(from).map((t) => `${t.role === 'user' ? 'Learner' : 'Tutor'}: ${t.text.slice(0, 1500)}`)
  ]
  const ex = s.exercises.map((e) => `Exercise "${e.title}": ${e.passed ? 'passed' : 'not passed'} after ${e.attempts} check(s)`)
  const res = await callLLM({
    providerId: provider.id,
    system: { stable: 'You write short notes about Smith-chart tutoring sessions, for the tutor to read before the next session. Plain text only.' },
    messages: [{
      role: 'user',
      parts: [{
        type: 'text',
        text: 'Summarise this session in at most 90 words: what was covered, what the learner did well, what they struggled with, and what to do next time.\n\n' +
          (s.digest ? `${lines.slice(0, 2).join('\n')}\n${[...lines.slice(2), ...ex].join('\n').slice(-9000)}` : [...lines, ...ex].join('\n').slice(-9000))
      }]
    }],
    maxTokens: 700
  })
  return textOf(res.message).trim()
}

/**
 * Running notes on a long lesson: the older part of the transcript (which no longer
 * fits the tutor's context) folded into the notes so far. A human tutor remembers
 * the start of a three-hour lesson; this is how the model does.
 */
async function digestTranscript(prev: string | undefined, part: SessionRecord['transcript']): Promise<string> {
  const provider = activeProvider()
  if (!provider) throw new Error('No model selected')
  // The caller sizes the part (about 14k characters), so nothing is cut here.
  const lines = part.map((t) => `${t.role === 'user' ? 'Learner' : 'Tutor'}: ${t.text.slice(0, 800)}`).join('\n')
  const res = await callLLM({
    providerId: provider.id,
    system: { stable: 'You keep running notes on a Smith-chart tutoring lesson that is still going on, for the tutor, whose context no longer holds the older messages. Plain text only.' },
    messages: [{
      role: 'user',
      parts: [{
        type: 'text',
        text: `${prev ? `Notes so far:\n${prev}\n\n` : ''}Next part of the lesson:\n${lines}\n\n` +
          'Rewrite the notes to cover the whole lesson so far, in at most 200 words. Start with "Learner told me:" and every fact the learner gave about themselves, ' +
          'their project or their difficulties (names, numbers, frequencies, what they say they mix up), carried over word for word from the notes so far: never drop one. ' +
          'Then: what was taught and how (the examples and explanations used, what clicked), what the learner asked, got right, got wrong or found confusing, ' +
          'and anything the tutor promised to come back to. Write neutral notes in the first person, as the tutor ("I explained…"), not instructions or criticism.'
      }]
    }],
    maxTokens: 900
  })
  return textOf(res.message).trim()
}

/** Model-free session notes, used when the model can't (or won't) summarise. */
function basicNotes(s: SessionRecord): string {
  const ex = s.exercises.map((e) => `${e.title} (${e.passed ? 'passed' : 'not passed'}, ${e.attempts} checks)`).join('; ')
  const asked = s.transcript.filter((t) => t.role === 'user').slice(-3).map((t) => `"${t.text.slice(0, 80)}"`).join(', ')
  return `[Auto-notes] ${s.transcript.length} messages.${ex ? ` Exercises: ${ex}.` : ''}${asked ? ` Learner's last messages: ${asked}.` : ''}`
}

/** The tutor's drawings and zoom belong to the lesson they were made in; a lesson starts with the traces and path visible. */
function clearTutorMarks() {
  const st = useStudio.getState()
  const o = st.overlays
  if (!o.showLoadTrace || !o.showInputTrace || !o.showPath) st.setOverlays({ showLoadTrace: true, showInputTrace: true, showPath: true })
  if (st.annotations.length) st.setAnnotations(() => [])
  if (st.tutorView) st.restoreView()
}

export const useTutor = create<TutorState>((set, get) => {
  const pushItem = (it: Omit<DisplayItem, 'id'>) => {
    const item = { ...it, id: iid() }
    const items = get().items
    set({ items: items.length >= MAX_ITEMS ? [...items.slice(-(MAX_ITEMS - 200)), item] : [...items, item] })
    return item.id
  }
  const patchItem = (id: string, fn: (i: DisplayItem) => DisplayItem) =>
    set({ items: get().items.map((i) => (i.id === id ? fn(i) : i)) })
  const removeItem = (id: string) => set({ items: get().items.filter((i) => i.id !== id) })

  const ensureSession = (): SessionRecord => {
    let s = get().session
    if (!s) {
      const skills = useApp.getState().profile?.skills
      s = {
        id: `s_${Date.now().toString(36)}`,
        startedAt: new Date().toISOString(),
        provider: activeProvider()?.label,
        transcript: [],
        exercises: [],
        skillsAtStart: skills ? masterySnapshot(skills) : undefined
      }
      set({ session: s, sessionStartedAt: Date.now() })
    }
    return s
  }

  /** Transcript entries dropped from the front so far (shifts indices into the transcript) */
  let droppedEntries = 0
  const logTranscript = (role: 'user' | 'tutor', text: string, model?: string) => {
    const s = ensureSession()
    const entry = { role, text: text.length > MAX_ENTRY_CHARS ? `${text.slice(0, MAX_ENTRY_CHARS)} […]` : text, at: new Date().toISOString(), ...(model ? { model } : {}) }
    if (s.transcript.length < MAX_TRANSCRIPT) {
      set({ session: { ...s, transcript: [...s.transcript, entry], ...(s.messageCount ? { messageCount: s.messageCount + 1 } : {}) } })
      return
    }
    // A very long lesson: the oldest messages go (the running notes cover them); the count stays true.
    const drop = 200
    droppedEntries += drop
    set({
      session: {
        ...s,
        transcript: [...s.transcript.slice(drop), entry],
        messageCount: (s.messageCount ?? s.transcript.length) + 1,
        ...(s.digest ? { digest: { ...s.digest, upTo: Math.max(0, s.digest.upTo - drop) } } : {})
      }
    })
  }

  /**
   * Note which model is teaching. A switch mid-lesson is shown to the learner
   * and recorded; the next model gets the lesson state in its system prompt.
   */
  const noteModel = (label: string) => {
    const s = ensureSession()
    const models = s.models ?? (s.provider && s.transcript.some((t) => t.role === 'tutor') ? [s.provider] : [])
    if (models[models.length - 1] === label) return
    if (models.length && s.transcript.some((t) => t.role === 'tutor')) {
      pushItem({ kind: 'system', text: `Tutor model changed: ${models[models.length - 1]} → ${label}. The lesson's goal, step and coordinates carry over.` })
    }
    set({ session: { ...s, models: [...models, label] } })
  }

  const persistSession = async () => {
    const s = get().session
    const pid = get().profileId
    if (!s || !pid || useApp.getState().profile?.id !== pid) return
    // Only lessons the learner took part in are kept.
    if (!countsAsLesson(s)) return
    await useApp.getState().updateProfile((p) => {
      const all = [...p.sessions.filter((x) => x.id !== s.id), s].slice(-200)
      // Older summarised lessons keep their summary and their last messages, not every message.
      const old = all.length - FULL_TRANSCRIPTS
      return { ...p, sessions: all.map((x, i) => (i < old && x.summary && x.transcript.length > 20 ? { ...x, messageCount: x.messageCount ?? x.transcript.length, transcript: x.transcript.slice(-20) } : x)) }
    })
  }

  /** Fold the older part of a long lesson into its running notes (in the background, after a turn). */
  let digesting = false
  let digestRetryAt = 0
  const maybeDigest = async () => {
    const s = get().session
    if (!s || digesting || !activeProvider()) return
    const from = s.digest?.upTo ?? 0
    const to = s.transcript.length - DIGEST_KEEP
    if (to - from < DIGEST_EVERY || s.transcript.length < digestRetryAt) return
    digesting = true
    try {
      // Oldest first, a chunk at a time, so nothing is cut when there's a backlog (an older saved lesson, a stretch offline).
      let at = from
      let notes = s.digest?.text
      const dropped0 = droppedEntries
      for (let n = 0; at < to && n < 8; n++) {
        let end = at
        for (let chars = 0; end < to && end - at < 80 && chars < 14000; end++) chars += Math.min(800, s.transcript[end].text.length) + 10
        notes = await digestTranscript(notes, s.transcript.slice(at, end))
        at = end
        const cur = get().session
        if (!notes || cur?.id !== s.id) return
        // Entries dropped from the front meanwhile shift the indices.
        set({ session: { ...cur, digest: { text: notes, upTo: Math.max(0, at - (droppedEntries - dropped0)) } } })
      }
    } catch {
      digestRetryAt = s.transcript.length + 10 // offline or refused: try again a little later
    } finally {
      digesting = false
    }
  }

  const ctx: ToolContext = {
    get studio() { return useStudio.getState() },
    derived: () => computeDerived(useStudio.getState().snapshot()),
    profile: () => useApp.getState().profile!,
    learnerTurns: () => get().learnerTurns,
    updateProfile: (fn) => useApp.getState().updateProfile(fn),
    recordExercise: (e) => {
      const ex = useStudio.getState().exercise
      if (ex) get().logExercise(ex, e.passed)
    },
    session: () => get().session,
    updateSession: (fn) => {
      set({ session: fn(ensureSession()) })
      persistSession().catch(console.error)
    },
    completeLesson: () => set({ completing: true }),
    followUpPending: () => get().followUpDue,
    autoRecorded: (skill) => get().autoRecorded.includes(skill)
  }

  /** One turn of the tutor, with what it said and did checked for faults afterwards (the issue log). */
  async function runAgent() {
    const audit = new TurnAudit('tutor', activeProvider()?.label, TOOLS.map((t) => t.name))
    try {
      await runSteps(audit)
    } finally {
      audit.finish()
    }
  }

  async function runSteps(audit: TurnAudit) {
    const provider = activeProvider()
    const profile = useApp.getState().profile
    if (!provider || !profile) {
      pushItem({ kind: 'error', text: 'No tutor model yet. Open the Models tab: the free local tutor sets itself up in one click, or add a cloud model (Claude, Gemini, GPT) with an API key.' })
      return
    }
    const tools = toolsFor(provider.supportsTools)
    noteModel(provider.label)
    // Loop guards that keep weaker models on track:
    let finalStep = false // a turn-ending tool ran: one more reply, then stop
    let spoke = false // has the tutor said anything this turn?
    let nudged = false
    let verified = false // what_if ran this turn, so move descriptions are grounded
    let verifyNudged = false
    let coordsNudges = 0
    let followNudged = false
    let directionFixes = 0
    let metaFixes = 0
    const callCounts = new Map<string, number>()
    const seenCalls = new Map<string, string>() // name+args → result, for identical repeats

    for (let step = 0; step < MAX_STEPS; step++) {
      const itemId = pushItem({ kind: 'tutor', text: '', streaming: true, model: provider.label })
      let res: ChatResult
      try {
        res = await callLLM(
          // Rebuilt every step: tools may have just updated the learner model or lesson state.
          { providerId: provider.id, system: buildSystemPrompt(useApp.getState().profile ?? profile, get().session), messages: historyForModel(get().history), tools },
          (delta) => patchItem(itemId, (i) => ({ ...i, text: i.text + delta })),
          (requestId) => set({ requestId })
        )
      } catch (e) {
        removeItem(itemId)
        pushItem({ kind: 'error', text: (e as Error).message })
        return
      }
      let message = res.message
      if (finalStep) {
        // The learner has the floor now: drop any further tool calls.
        message = { role: 'assistant', parts: message.parts.filter((p) => p.type === 'text') }
        // The card already speaks; a bracketed aside ("(The question is on the screen!)") adds nothing.
        if (isStageDirection(textOf(message))) message = { role: 'assistant', parts: [] }
      }
      const text = textOf(message)
      set({ usage: { input: get().usage.input + (res.usage.inputTokens ?? 0), output: get().usage.output + (res.usage.outputTokens ?? 0) } })

      // Every statement about how a point moves must rest on known coordinates and on what_if this turn.
      // Otherwise withdraw the reply (before any of its tool calls run) and have it established, verified and restated.
      const claims = moveClaims(text).length > 0
      const coordsUnknown = get().session?.plan?.coordinates === 'unknown'
      // Text about the machinery ("This response is hidden from the learner. Retry now.") is never shown.
      if (isMetaReply(text)) {
        audit.event('guard', 'reply about the machinery withdrawn')
        removeItem(itemId)
        if (metaFixes++ >= 2) return
        const h = get().history
        const last = h[h.length - 1]
        const nudge: Part = { type: 'text', text: META_NUDGE }
        set({ history: last?.role === 'user' ? [...h.slice(0, -1), { ...last, parts: [...last.parts, nudge] }] : [...h, { role: 'user', parts: [nudge] }] })
        continue
      }

      // A direction that contradicts fixed physics is wrong whatever was checked: have it rewritten.
      const wrongDirections = directionErrors(text)
      const needFix = wrongDirections.length > 0 && directionFixes < 2
      // After a card, tool calls are dropped, so a nudge asking for what_if couldn't be met.
      const needCoords = claims && coordsUnknown && coordsNudges < 2 && !finalStep
      const needVerify = claims && !verified && !verifyNudged && !finalStep
      if (needFix || needCoords || needVerify) {
        if (needFix) directionFixes++
        if (needCoords) coordsNudges++
        if (needVerify) verifyNudged = true
        audit.event('guard', needFix ? `wrong direction rewritten (${wrongDirections.map((e) => e.fix).join('; ').slice(0, 120)})` : needCoords ? 'move described with coordinates unknown' : 'move described without checking it (what_if)')
        removeItem(itemId)
        pushItem({ kind: 'tool', text: 'Double-checking that on the chart…' })
        const h = get().history
        const last = h[h.length - 1]
        const nudgeText = needFix ? directionNudge(wrongDirections) : needCoords ? `${COORDINATES_NUDGE}\n${VERIFY_NUDGE}` : VERIFY_NUDGE
        const nudge: Part = { type: 'text', text: nudgeText }
        // Keep user/assistant turns alternating: add to the last user turn if there is one.
        set({ history: last?.role === 'user' ? [...h.slice(0, -1), { ...last, parts: [...last.parts, nudge] }] : [...h, { role: 'user', parts: [nudge] }] })
        continue
      }

      const calls = message.parts.filter((p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call')
      // A question in the reply pays the follow-up (unless the same reply also closes the lesson).
      if (get().followUpDue && /\?/.test(text) && !calls.some((x) => x.name === 'complete_lesson')) set({ followUpDue: false })

      if (text.trim()) {
        spoke = true
        patchItem(itemId, (i) => ({ ...i, text, streaming: false }))
        logTranscript('tutor', text, provider.label)
        audit.said(text)
        // The model wouldn't establish the coordinates: show the reply, but say plainly that it's unconfirmed.
        if (claims && coordsUnknown) {
          pushItem({ kind: 'system', text: "Careful: the tutor hasn't confirmed whether it means impedance (z) or admittance (y), so the directions above aren't checked. Ask it which one." })
        }
        // Still wrong after two rewrites: show it, but correct it plainly for the learner.
        if (wrongDirections.length) {
          const fix = wrongDirections.map((e) => e.fix).join('; ')
          pushItem({ kind: 'system', text: `Correction from the app: ${fix.charAt(0).toUpperCase()}${fix.slice(1)}.` })
        }
      } else removeItem(itemId)
      if (message.parts.length) set({ history: [...get().history, message] })

      if (calls.length === 0) {
        // Solved, praised, but no follow-up asked: ask for it once.
        if (spoke && get().followUpDue && !followNudged && !get().completing) {
          followNudged = true
          audit.event('guard', 'follow-up question owed, asked for it')
          set({ history: [...get().history, { role: 'user', parts: [{ type: 'text', text: FOLLOW_UP_NUDGE }] }] })
          continue
        }
        if (spoke || nudged) return
        // Model returned nothing: ask once for a reply.
        nudged = true
        audit.event('empty-reply', 'returned nothing')
        set({ history: [...get().history, { role: 'user', parts: [{ type: 'text', text: '[System] Please reply to the learner now, in plain text.' }] }] })
        continue
      }
      const results: Part[] = []
      for (const call of calls) {
        const key = `${call.name}:${JSON.stringify(call.args)}`
        const prior = READ_ONLY.has(call.name) ? seenCalls.get(key) : undefined
        if (prior !== undefined && !endsTurn(call.name)) {
          results.push({ type: 'tool_result', callId: call.id, name: call.name, content: `Same call already made this turn; result unchanged: ${prior}` })
          continue
        }
        const n = (callCounts.get(call.name) ?? 0) + 1
        callCounts.set(call.name, n)
        const toolItem = pushItem({ kind: 'tool', text: toolActivity(call.name, call.args) + '…' })
        // One card per turn: refused once a turn-ending tool has succeeded (a failed attempt may be retried).
        const r = endsTurn(call.name) && finalStep
          ? { content: `Already done this turn. Do not call ${call.name} again; reply to the learner and wait.`, isError: true }
          : n > 4
            ? { content: `You have called ${call.name} ${n} times this turn. Stop calling tools and reply to the learner.`, isError: true }
            : await runTool(call.name, call.args, ctx)
        patchItem(toolItem, (i) => ({ ...i, text: toolActivity(call.name, call.args) + (r.isError ? ' (skipped)' : '') }))
        if (r.isError && /Already done|times this turn/.test(r.content)) removeItem(toolItem)
        results.push({ type: 'tool_result', callId: call.id, name: call.name, content: r.content, isError: r.isError })
        audit.tool(call.name, !r.isError, r.content)
        if (!r.isError) {
          if (READ_ONLY.has(call.name)) seenCalls.set(key, r.content.slice(0, 4000))
          else seenCalls.clear()
        }
        if (call.name === 'what_if' && !r.isError) verified = true
        if (ASKING_TOOLS.has(call.name) && !r.isError && get().followUpDue) {
          set({ followUpDue: false })
          // Mark the card as the follow-up so the learner sees it's optional.
          const p = useStudio.getState().prediction
          if (p) useStudio.getState().setPrediction({ ...p, followUp: true })
        }
        if (endsTurn(call.name) && !r.isError) {
          finalStep = true
          // A card on screen is the tutor speaking: an empty reply after it is fine, no "please reply" nudge.
          spoke = true
        }
      }
      set({ history: [...get().history, { role: 'user', parts: results }] })
      // It already spoke in the reply that set the card (or closed the lesson): the learner has the floor.
      if (finalStep && text.trim()) return
    }
    audit.event('step-limit', `${MAX_STEPS} steps`)
    pushItem({ kind: 'system', text: 'The tutor took many steps in a row; paused here. Say something to continue.' })
  }

  /**
   * Sessions that were never ended (app closed, profile switched…) have a
   * transcript but no summary. Summarise them so the tutor remembers them.
   */
  async function summarizeStaleSessions() {
    const profile = useApp.getState().profile
    if (!activeProvider() || !profile) return
    const current = get().session?.id
    const stale = profile.sessions.filter((s) => !s.summary && s.id !== current && s.transcript.length >= 2).slice(-3)
    for (const s of stale) {
      let summary = ''
      try {
        summary = await summarizeTranscript(s)
      } catch {
        return // offline or no key: try again next time
      }
      if (!summary) continue
      await useApp.getState().updateProfile((p) => ({
        ...p,
        sessions: p.sessions.map((x) => (x.id === s.id ? { ...x, summary, endedAt: x.endedAt ?? x.transcript[x.transcript.length - 1]?.at } : x))
      }))
    }
  }

  return {
    profileId: null,
    ...FRESH(),

    async send(text, opts = {}) {
      if (get().busy) return
      ensureSession()
      const studio = useStudio.getState()
      const events = studio.eventsSince(get().lastSeenEventAt)
      const activity = events.length
        ? `\n\n[Chart activity since your last turn]\n${events.map((e) => `- ${e.text}`).join('\n')}`
        : ''
      const isLearnerInput = !opts.hidden
      // Typing to the tutor while a graded card is open is asking for help: the answer then counts as partly theirs.
      if (isLearnerInput && !opts.learnerAction) {
        const st = useStudio.getState()
        if (st.prediction?.key && !st.prediction.answered && !st.prediction.helped) st.setPrediction({ ...st.prediction, helped: true })
        if (st.exercise?.status === 'active' && st.exercise.graded && !st.exercise.helped) st.setExercise({ ...st.exercise, helped: true })
      }
      set({ lastSeenEventAt: Date.now(), busy: true, learnerTurns: get().learnerTurns + (isLearnerInput ? 1 : 0), followUpDue: !!opts.followUp, autoRecorded: opts.autoRecorded ?? [] })
      const shown = opts.display ?? text
      pushItem({ kind: opts.hidden ? 'system' : 'user', text: shown })
      if (isLearnerInput) logTranscript('user', shown)
      // A turn that ended on a card (no reply after it) leaves a user turn last: add to it, keeping turns alternating.
      const h = get().history
      const last = h[h.length - 1]
      // They typed instead of answering the open card: answer them, but the card is still theirs to answer.
      const open = useStudio.getState().prediction
      const cardNote = isLearnerInput && !opts.learnerAction && open && !open.answered
        ? `\n\n[A question card is still open, unanswered: "${open.question.slice(0, 200)}". Reply to what they said. Don't state or imply the card's answer, even in passing; if they ask for help with it, give a nudge, not the answer. Then hand back to the card.]`
        : ''
      const said: Part = { type: 'text', text: text + activity + cardNote }
      set({ history: last?.role === 'user' ? [...h.slice(0, -1), { ...last, parts: [...last.parts, said] }] : [...h, { role: 'user', parts: [said] }] })
      try {
        await runAgent()
      } finally {
        // Owed only for the turn right after solving; the learner may have moved on by the next one.
        // The model only ever gets the recent history: keep a bounded amount of it in memory too.
        const h = get().history
        set({ busy: false, requestId: null, followUpDue: false, ...(h.length > MAX_HISTORY * 3 ? { history: trimHistory(h, MAX_HISTORY * 2) } : {}) })
        persistSession().catch(console.error)
        maybeDigest().catch(console.error)
      }
      // The tutor reached the lesson goal and has given its recap: wrap the lesson up.
      if (get().completing) await get().endSession()
    },

    logExercise(ex, passed) {
      const s = ensureSession()
      if (s.exercises.some((e) => e.id === ex.id)) return
      set({ session: { ...s, exercises: [...s.exercises, { id: ex.id, ...(ex.kind ? { kind: ex.kind } : {}), title: ex.title, skill: ex.skill as never, passed, attempts: ex.attempts, at: new Date().toISOString() }] } })
      persistSession().catch(console.error)
    },

    stop() {
      const id = get().requestId
      if (id) api().llm.abort(id)
    },

    async startSession(focus, design) {
      if (get().history.length || get().busy) return
      const p = useApp.getState().profile
      const n = (p ? lessonsOf(p).length : 0) + 1
      set({ sessionStartedAt: Date.now(), lastEnded: null, notice: null })
      // A new lesson starts on a clean chart: the last lesson's drawings would label the wrong things.
      clearTutorMarks()
      const s = ensureSession()
      set({ session: { ...s, focus } })
      summarizeStaleSessions().catch(console.error)
      if (design) {
        await get().send(designOpening(n, design), { hidden: true, display: `Lesson ${n} started · your design` })
        return
      }
      const label = focus === 'own' ? 'your question' : focus === 'probe' ? 'check yourself' : focus ? skillName(focus) : "tutor's pick"
      // Only offered once there's something to review; never for "own question" or check-yourself lessons.
      const review = !!p?.preferences.reviewFirst && focus !== 'own' && focus !== 'probe' && !!p && hasReviewMaterial(p)
      await get().send(lessonOpening(n, focus, review), { hidden: true, display: `Lesson ${n} started · ${label}${review ? ' · with a quick review' : ''}` })
    },

    async endSession() {
      if (get().busy) return
      const ex = useStudio.getState().exercise
      if (ex && ex.attempts > 0) get().logExercise(ex, ex.status === 'passed')
      const provider = activeProvider()
      const s = get().session
      const completed = get().completing
      if (!s || !countsAsLesson(s)) {
        // Opened but never taken part in: nothing to learn from, so it isn't saved or counted.
        useStudio.getState().setExercise(null)
        get().reset()
        if (s) set({ notice: "That lesson wasn't saved: you hadn't answered anything yet." })
        return
      }
      set({ busy: true })
      let summary = ''
      if (provider && s.transcript.length >= 2) {
        const itemId = pushItem({ kind: 'system', text: 'Writing a lesson summary…' })
        try {
          summary = await summarizeTranscript(get().session!)
          if (!summary) throw new Error('empty summary')
        } catch (e) {
          // Never leave the tutor without memory of a lesson: fall back to notes built from the record.
          summary = basicNotes(get().session!)
          patchItem(itemId, (i) => ({ ...i, text: `The model couldn't write a summary (${(e as Error).message}). Saved basic notes instead.` }))
        }
      }
      const cur = get().session!
      const plan = cur.plan
      const skills = useApp.getState().profile?.skills
      set({
        session: {
          ...cur,
          summary: summary || cur.summary,
          endedAt: new Date().toISOString(),
          outcome: completed || (plan && plan.step >= plan.steps.length) ? 'completed' : 'partial',
          skillsAtEnd: skills ? masterySnapshot(skills) : undefined
        }
      })
      await persistSession()
      const ended = get().session
      useStudio.getState().setExercise(null)
      get().reset()
      set({ lastEnded: ended })
    },

    reset() {
      useStudio.getState().setPrediction(null)
      clearTutorMarks()
      // The tutor's worked example belonged to that lesson.
      if (useCalc.getState().tutorNote) useCalc.getState().set({}, 'learner')
      set(FRESH())
    }
  }
})

registerBusy(() => useTutor.getState().busy)

// ---- persistence: one live conversation per profile -------------------------

let saveTimer: ReturnType<typeof setTimeout> | undefined

function conversationOf(s: TutorState): Conversation | null {
  if (s.items.length === 0 && s.history.length === 0) return null
  return {
    v: 1,
    items: s.items.filter((i) => !i.streaming || i.text).map((i) => ({ ...i, streaming: false })).slice(-300),
    history: trimHistory(s.history, MAX_HISTORY * 2),
    session: s.session,
    sessionStartedAt: s.sessionStartedAt,
    learnerTurns: s.learnerTurns,
    usage: s.usage,
    savedAt: new Date().toISOString()
  }
}

export function flushConversation() {
  clearTimeout(saveTimer)
  const s = useTutor.getState()
  if (s.profileId) return api().conversation.save(s.profileId, conversationOf(s))
}

useTutor.subscribe((s, prev) => {
  if (!s.profileId || s.profileId !== prev.profileId) return
  if (s.items === prev.items && s.history === prev.history && s.session === prev.session) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(flushConversation, 600)
})

/** Swap conversations when the active profile changes (also runs at startup). */
async function loadConversation(profileId: string) {
  const c = (await api().conversation.get(profileId)) as Conversation | null
  if (useApp.getState().profile?.id !== profileId) return // switched again meanwhile
  if (!c || c.v !== 1) {
    useTutor.setState({ profileId, ...FRESH() })
    return
  }
  const when = new Date(c.savedAt)
  const note: DisplayItem = {
    id: iid(),
    kind: 'system',
    text: `Lesson in progress since ${when.toLocaleString()}: carry on where you left off.`
  }
  useTutor.setState({
    profileId,
    ...FRESH(),
    // One "in progress since" note: the latest. (Each launch used to add another.)
    items: [...c.items.filter((i) => !(i.kind === 'system' && i.text.startsWith('Lesson in progress since '))), note],
    history: c.history,
    // Lessons saved before coordinates were recorded: infer them, or mark them unknown (never assume impedance).
    session: c.session ? migrateLessonState(c.session) : c.session,
    sessionStartedAt: c.sessionStartedAt,
    learnerTurns: c.learnerTurns,
    usage: c.usage ?? { input: 0, output: 0 },
    lastSeenEventAt: Date.now()
  })
}

useApp.subscribe((s, prev) => {
  const id = s.profile?.id ?? null
  if (id === (prev.profile?.id ?? null)) return
  const t = useTutor.getState()
  if (t.busy) t.stop()
  if (t.profileId) flushConversation()
  useTutor.setState({ profileId: null, ...FRESH() })
  if (id) loadConversation(id).catch(console.error)
})

window.addEventListener('beforeunload', () => {
  flushConversation()
})
