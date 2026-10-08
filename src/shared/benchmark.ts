import type { ChatMessage, ChatRequest, ChatResult, Part, ToolSpec } from './llm'
import { textOf } from './llm'
import { c } from './rf/complex'
import { metricsFromZ } from './rf/metrics'

/**
 * Model benchmark. Each attribute maps to a job the model does in the app, so
 * the user can pick a model for what they care about. All checks are graded
 * by code (never by another LLM), so scores are comparable across models.
 */

export const SUITE_VERSION = 4

export type Attribute = 'guiding' | 'rf_knowledge' | 'rf_math' | 'tools' | 'learner' | 'summary' | 'speed'

export const ATTRIBUTES: Array<{ id: Attribute; name: string; usedFor: string; weight: number }> = [
  { id: 'guiding', name: 'Guiding', usedFor: 'Socratic tutoring: asks instead of telling, corrects wrong ideas, gives hints without the answer', weight: 0.2 },
  { id: 'tools', name: 'Tool use', usedFor: 'Driving the chart, exercises and calculators (the agent loop)', weight: 0.25 },
  { id: 'rf_knowledge', name: 'RF knowledge', usedFor: 'Explaining Smith-chart concepts correctly', weight: 0.15 },
  { id: 'rf_math', name: 'RF maths', usedFor: 'Numbers without the calculator (the tutor is told to use tools, so this matters less)', weight: 0.05 },
  { id: 'learner', name: 'Learner tracking', usedFor: 'Recording progress and misconceptions accurately (your profile)', weight: 0.1 },
  { id: 'summary', name: 'Summaries', usedFor: 'Session notes the tutor reads next time (its memory)', weight: 0.1 },
  { id: 'speed', name: 'Speed', usedFor: 'How responsive the chat feels', weight: 0.15 }
]

export interface BenchCheck {
  id: string
  name: string
  category: Attribute
  score: number
  detail: string
  ms?: number
  /** The check could not run because of an API/transport error (not the model's fault) */
  error?: boolean
}

export type Tier = 'Excellent' | 'Good' | 'Usable' | 'Limited' | 'Failed'

export interface BenchmarkReport {
  /** Unique run id */
  id?: string
  suiteVersion?: number
  providerId: string
  providerLabel: string
  kind?: string
  model: string
  at: string
  /** 'reference' = shipped with the app; 'user' = run on this machine */
  source?: 'reference' | 'user'
  /** Hardware note for local models (speed depends on it) */
  machine?: string
  checks: BenchCheck[]
  metrics: { ttftMs: number | null; tokensPerSec: number | null; avgLatencyMs: number; totalTokens?: number }
  scores: Partial<Record<Attribute | 'overall', number>> & { overall: number }
  /** Number of checks that hit API errors (rate limits, overload…); scores are unreliable when > 0 */
  incomplete?: number
  tier: Tier
  advice: string[]
}

export type ChatFn = (req: Omit<ChatRequest, 'providerId'>) => Promise<ChatResult>

// ---------------------------------------------------------------------------

const BASIC_TOOLS: ToolSpec[] = [
  {
    name: 'rf_metrics',
    description: 'Compute reflection coefficient, VSWR and return loss for an impedance.',
    parameters: {
      type: 'object',
      properties: {
        r_ohm: { type: 'number', description: 'Resistance in ohms' },
        x_ohm: { type: 'number', description: 'Reactance in ohms' },
        z0_ohm: { type: 'number', description: 'Reference impedance in ohms' }
      },
      required: ['r_ohm', 'x_ohm', 'z0_ohm']
    }
  },
  {
    name: 'add_marker',
    description: 'Place a frequency marker on the Smith chart.',
    parameters: { type: 'object', properties: { freq_hz: { type: 'number' } }, required: ['freq_hz'] }
  }
]

const CHAIN_TOOLS: ToolSpec[] = [
  { name: 'get_chart_state', description: 'Read the learner\'s Smith chart: Z0, load impedance, design frequency.', parameters: { type: 'object', properties: {} } },
  BASIC_TOOLS[0]
]

const EDIT_TOOLS: ToolSpec[] = [
  {
    name: 'edit_network',
    description: 'Add an element to the matching network. Values are in SI units: henries for inductors, farads for capacitors, ohms for resistors.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove'] },
        kind: { type: 'string', enum: ['seriesL', 'seriesC', 'shuntL', 'shuntC', 'seriesR', 'shuntR'] },
        value: { type: 'number', description: 'SI units (H, F, Ω)' }
      },
      required: ['action', 'kind', 'value']
    }
  }
]

const PREDICT_TOOLS: ToolSpec[] = [
  {
    name: 'ask_prediction',
    description: 'Show the learner a prediction question card. Their answer arrives as their next message; after calling this, stop and wait.',
    parameters: { type: 'object', properties: { question: { type: 'string' }, choices: { type: 'array', items: { type: 'string' } } }, required: ['question'] }
  }
]

const SKILL_IDS = ['chart_basics', 'reflection', 'admittance', 'lumped_moves', 'l_match', 'tlines', 'stubs', 'q_bandwidth', 'sweep_reading']
const LEARNER_TOOLS: ToolSpec[] = [
  {
    name: 'record_evidence',
    description: 'Update the learner model after observing the learner use a skill.',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', enum: SKILL_IDS },
        outcome: { type: 'string', enum: ['correct', 'partial', 'incorrect'] },
        difficulty: { type: 'number', enum: [1, 2, 3] }
      },
      required: ['skill', 'outcome', 'difficulty']
    }
  },
  {
    name: 'log_misconception',
    description: 'Record a specific wrong mental model the learner showed.',
    parameters: { type: 'object', properties: { skill: { type: 'string', enum: SKILL_IDS }, description: { type: 'string' } }, required: ['skill', 'description'] }
  }
]

const MATH = [
  { id: 'q1', text: 'Magnitude of the reflection coefficient |Γ| for a 75 Ω resistive load on a 50 Ω system', answer: 0.2 },
  { id: 'q2', text: 'VSWR when |Γ| = 0.2', answer: 1.5 },
  { id: 'q3', text: 'Return loss in dB when |Γ| = 0.1', answer: 20 },
  { id: 'q4', text: 'Characteristic impedance (Ω) of a quarter-wave transformer matching 50 Ω to 112.5 Ω', answer: 75 },
  { id: 'q5', text: 'Real part of the normalized admittance y for z = 1 + j1', answer: 0.5 },
  { id: 'q6', text: 'Magnitude of the series reactance (Ω) in an L-network matching a 10 Ω load to 50 Ω, series element next to the 10 Ω load', answer: 20 }
]

const KNOWLEDGE = [
  { id: 'k1', q: 'Adding a series inductor moves the point on a Smith chart: A) clockwise on a constant-r circle B) counter-clockwise on a constant-r circle C) clockwise on a constant-g circle D) radially inward', a: 'A' },
  { id: 'k2', q: 'Adding a shunt inductor moves the point: A) clockwise on a constant-g circle B) counter-clockwise on a constant-g circle C) clockwise on a constant-r circle D) it does not move', a: 'B' },
  { id: 'k3', q: 'Moving toward the generator along a lossless line rotates the point: A) counter-clockwise B) clockwise C) toward the centre D) toward the open circuit', a: 'B' },
  { id: 'k4', q: 'One full revolution around the Smith chart corresponds to a line length of: A) λ/4 B) λ C) λ/2 D) 2λ', a: 'C' },
  { id: 'k5', q: 'For a passive antenna, as frequency increases its S11 trace on the Smith chart generally moves: A) clockwise B) counter-clockwise C) radially outward D) randomly', a: 'A' },
  { id: 'k6', q: 'Keeping the matching path inside a low-Q contour gives: A) narrower bandwidth B) higher loss C) wider bandwidth D) no effect', a: 'C' },
  { id: 'k7', q: 'The admittance of a point on the Smith chart is found by: A) reflecting across the imaginary axis B) rotating 180° about the centre C) rotating 90° D) moving to the rim', a: 'B' },
  { id: 'k8', q: 'In single shunt-stub matching, the line from the load should bring the admittance to: A) the r = 1 circle B) the real axis C) the g = 1 circle D) the rim', a: 'C' },
  { id: 'k9', q: 'A lossless quarter-wave line terminated in a short circuit looks, at its input, like: A) a short B) an open C) a matched load D) an inductor of Z0', a: 'B' },
  { id: 'k10', q: 'The input impedance of a lossless λ/8 short-circuited stub of characteristic impedance Z0 is: A) +jZ0 B) −jZ0 C) Z0 D) 0', a: 'A' },
  { id: 'k11', q: 'On a 50 Ω chart, the constant-VSWR circle for VSWR = 3 has normalized radius: A) 0.33 B) 0.5 C) 0.67 D) 0.75', a: 'B' },
  { id: 'k12', q: 'The voltage minimum on a mismatched line corresponds to which point of the VSWR circle on the Smith chart? A) where it crosses the right real axis (r > 1) B) where it crosses the left real axis (r < 1) C) the top of the circle D) the bottom of the circle', a: 'B' }
]

const SOCRATIC = 'You are a Socratic Smith-chart tutor. Your goal is to make the learner think. Never give final answers or component values before the learner has tried; ask one guiding question at a time and keep replies short.'

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
const user = (text: string): ChatMessage => ({ role: 'user', parts: [{ type: 'text', text }] })
const asst = (text: string): ChatMessage => ({ role: 'assistant', parts: [{ type: 'text', text }] })
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length
const calls = (m: ChatMessage) => m.parts.filter((p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call')
/** Component values for 25 → 50 Ω at 1 GHz (both L-match solutions) */
const LEAKS = /3\.9[0-9]?\s*n\s*H|3\.1[0-9]?\s*p\s*F|7\.9[0-9]?\s*n\s*H|6\.3[0-9]?\s*p\s*F/i
const asksQuestion = (s: string) => /\?/.test(s)
/** "clockwise" used as the correction, ignoring "counter-clockwise" and friends */
const challenges = (s: string) => /which (way|direction)|direction|rotat/i.test(s)
const saysClockwise = (s: string) => /\bclockwise\b/i.test(s.replace(/(counter|anti)[\s-]?clockwise/gi, ''))

function extractJson(s: string): Record<string, unknown> | null {
  const t = s.replace(/<think>[\s\S]*?<\/think>/g, '')
  const m = t.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    return JSON.parse(m[0])
  } catch {
    return null
  }
}

function near(v: unknown, target: number) {
  const n = Number(v)
  return Number.isFinite(n) && Math.abs(n - target) <= Math.max(1e-6, Math.abs(target) * 0.01)
}

export async function runBenchmark(
  chat: ChatFn,
  meta: { providerId: string; providerLabel: string; model: string; kind?: string; machine?: string },
  onProgress: (msg: string, checks: BenchCheck[]) => void = () => {}
): Promise<BenchmarkReport> {
  const checks: BenchCheck[] = []
  const latencies: number[] = []
  let tokens = 0
  let ttftMs: number | null = null
  let tokensPerSec: number | null = null

  const push = (ck: BenchCheck) => {
    checks.push(ck)
    onProgress(`${ck.name}: ${Math.round(ck.score * 100)}%`, [...checks])
  }
  /** Run one model call; failures become an Error value instead of throwing. */
  const call = async (label: string, req: Omit<ChatRequest, 'providerId'>): Promise<ChatResult | Error> => {
    onProgress(`Running: ${label}`, [...checks])
    try {
      const r = await chat(req)
      latencies.push(r.timing.totalMs)
      tokens += (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0)
      return r
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    }
  }
  // Transport/quota problems are not the model's fault; a missing capability (e.g. "does not support tools") is.
  const isApiError = (m: string) => /HTTP (408|409|425|429|5\d\d)|overloaded|high demand|quota|rate.?limit|timeout|ECONN|fetch failed|ended without a response/i.test(m)
  const fail = (id: string, name: string, category: Attribute, e: Error) =>
    push({ id, name, category, score: 0, detail: e.message.slice(0, 300), error: isApiError(e.message) })

  // ---- speed -----------------------------------------------------------------
  const ping = await call('connectivity', { system: { stable: 'You are a test endpoint.' }, messages: [user('Reply with exactly the word READY and nothing else.')], maxTokens: 300 })
  if (ping instanceof Error) {
    fail('ping', 'Connectivity', 'speed', ping)
    return finish()
  }
  push({ id: 'ping', name: 'Connectivity', category: 'speed', ms: ping.timing.totalMs, score: /READY/i.test(textOf(ping.message)) ? 1 : 0.5, detail: `Answered in ${Math.round(ping.timing.totalMs)} ms (cold start; local models load on first use)` })

  const tp = await call('speed', { system: { stable: 'You are a concise RF engineering tutor.' }, messages: [user('In about 150 words, explain why the Smith chart maps the right half of the impedance plane into the unit circle.')], maxTokens: 1500 })
  if (tp instanceof Error) fail('throughput', 'Speed', 'speed', tp)
  else {
    const text = textOf(tp.message)
    const outTok = tp.usage.outputTokens ?? Math.round(text.length / 4)
    // Hidden reasoning tokens count in usage, so measure generation from the first byte of any kind.
    const genMs = tp.timing.totalMs - (tp.timing.firstByteMs ?? tp.timing.ttftMs ?? 0)
    tokensPerSec = genMs > 0 ? (outTok / genMs) * 1000 : null
    ttftMs = tp.timing.ttftMs
    const tpsScore = tokensPerSec ? clamp01(tokensPerSec / 50) : 0.3
    // First visible token: ≤1 s is great, ≥8 s feels broken (reasoning models pay here).
    const ttftScore = ttftMs !== null ? clamp01(1 - (ttftMs - 1000) / 7000) : 0.5
    push({ id: 'throughput', name: 'Speed', category: 'speed', ms: tp.timing.totalMs, score: 0.5 * tpsScore + 0.5 * ttftScore, detail: `${tokensPerSec ? tokensPerSec.toFixed(1) : '?'} tokens/s, first visible token ${ttftMs === null ? 'n/a' : Math.round(ttftMs) + ' ms'}` })
  }

  // ---- tools -----------------------------------------------------------------
  const toolSys = { stable: 'You are an RF assistant inside an app. Use the provided tools for calculations and for reading app state instead of guessing.' }
  const q = user('What is the VSWR of a 100 + j0 Ω load on a 50 Ω system? Use a tool.')
  const t1 = await call('tool call', { system: toolSys, messages: [q], tools: BASIC_TOOLS, maxTokens: 1500 })
  if (t1 instanceof Error) {
    fail('tool_call', 'Picks the right tool', 'tools', t1)
    fail('tool_rt', 'Uses the tool result', 'tools', t1)
  } else {
    const call1 = calls(t1.message)[0]
    let score = 0
    let detail = 'Answered in text instead of calling a tool'
    if (call1) {
      const a = call1.args as Record<string, unknown>
      const okArgs = near(a.r_ohm, 100) && near(a.x_ohm, 0) && near(a.z0_ohm, 50)
      score = call1.name === 'rf_metrics' ? (okArgs ? 1 : 0.6) : 0.3
      detail = `Called ${call1.name}(${JSON.stringify(a)})${okArgs ? '' : ' — arguments not as expected'}`
    }
    push({ id: 'tool_call', name: 'Picks the right tool', category: 'tools', score, detail, ms: t1.timing.totalMs })
    if (call1) {
      const t2 = await call('tool result', {
        system: toolSys,
        messages: [q, t1.message, { role: 'user', parts: [{ type: 'tool_result', callId: call1.id, name: call1.name, content: JSON.stringify({ gamma_mag: 0.3333, vswr: 2.0, return_loss_db: 9.54 }) }] }],
        tools: BASIC_TOOLS,
        maxTokens: 1500
      })
      if (t2 instanceof Error) fail('tool_rt', 'Uses the tool result', 'tools', t2)
      else {
        const txt = textOf(t2.message)
        push({ id: 'tool_rt', name: 'Uses the tool result', category: 'tools', ms: t2.timing.totalMs, score: /\b2(\.0+)?\b/.test(txt) ? 1 : 0.2, detail: txt ? `"${txt.slice(0, 120)}${txt.length > 120 ? '…' : ''}"` : 'No answer after the tool result' })
      }
    } else push({ id: 'tool_rt', name: 'Uses the tool result', category: 'tools', score: 0, detail: 'Skipped (no tool call)' })
  }

  // Multi-step: must read state first, then compute (the real agent pattern).
  {
    const msgs: ChatMessage[] = [user('What is the VSWR of the load on my chart right now?')]
    let readState = false
    let computed = false
    let final = ''
    let err: Error | null = null
    for (let step = 0; step < 4; step++) {
      const r = await call('multi-step tools', { system: toolSys, messages: msgs, tools: CHAIN_TOOLS, maxTokens: 1500 })
      if (r instanceof Error) { err = r; break }
      msgs.push(r.message)
      const cs = calls(r.message)
      if (!cs.length) { final = textOf(r.message); break }
      const results: Part[] = cs.map((cl) => {
        if (cl.name === 'get_chart_state') {
          readState = true
          return { type: 'tool_result', callId: cl.id, name: cl.name, content: JSON.stringify({ z0_ohm: 50, load_ohm: { r: 25, x: 25 }, design_freq: '2.4 GHz' }) }
        }
        const a = cl.args as Record<string, unknown>
        if (cl.name === 'rf_metrics' && near(a.r_ohm, 25) && near(a.x_ohm, 25)) computed = true
        const m = metricsFromZ(c(Number(a.r_ohm) || 0, Number(a.x_ohm) || 0), Number(a.z0_ohm) || 50)
        return { type: 'tool_result', callId: cl.id, name: cl.name, content: JSON.stringify({ gamma_mag: +m.gammaMag.toFixed(4), vswr: +m.vswr.toFixed(3), return_loss_db: +m.returnLossDb.toFixed(2) }) }
      })
      msgs.push({ role: 'user', parts: results })
    }
    if (err) fail('tool_chain', 'Multi-step tool use', 'tools', err)
    else {
      const right = /2\.6[0-9]?/.test(final)
      push({
        id: 'tool_chain', name: 'Multi-step tool use', category: 'tools',
        score: (readState ? 0.4 : 0) + (computed ? 0.2 : 0) + (right ? 0.4 : 0),
        detail: `${readState ? 'read the chart' : 'did NOT read the chart'}, ${computed ? 'computed with the tool' : 'no calculator call'}, ${right ? 'correct VSWR 2.62' : 'wrong/missing final answer'}`
      })
    }
  }

  // Units: the model must convert "2.2 nH" to SI for the tool. It may add the parts in one turn or one per turn.
  {
    const msgs: ChatMessage[] = [user('Add a 2.2 nH series inductor and then a 1.5 pF shunt capacitor to my matching network.')]
    const all: Array<Extract<Part, { type: 'tool_call' }>> = []
    let err: Error | null = null
    for (let step = 0; step < 3; step++) {
      const r = await call('tool units', { system: toolSys, messages: msgs, tools: EDIT_TOOLS, maxTokens: 1500 })
      if (r instanceof Error) { err = r; break }
      const cs = calls(r.message)
      if (!cs.length) break
      all.push(...cs)
      msgs.push(r.message, { role: 'user', parts: cs.map((x) => ({ type: 'tool_result' as const, callId: x.id, name: x.name, content: 'Added.' })) })
      if (all.some((x) => x.args.kind === 'seriesL') && all.some((x) => x.args.kind === 'shuntC')) break
    }
    if (err && !all.length) fail('tool_units', 'Converts units for tools', 'tools', err)
    else {
      const l = all.find((x) => x.args.kind === 'seriesL')
      const cc = all.find((x) => x.args.kind === 'shuntC')
      const okL = l && Math.abs(Number(l.args.value) - 2.2e-9) < 0.05e-9
      const okC = cc && Math.abs(Number(cc.args.value) - 1.5e-12) < 0.05e-12
      push({
        id: 'tool_units', name: 'Converts units for tools', category: 'tools',
        score: (okL ? 0.5 : l ? 0.15 : 0) + (okC ? 0.5 : cc ? 0.15 : 0),
        detail: all.length ? all.map((x) => `${x.args.kind}=${x.args.value}`).join(', ') + (okL && okC ? ' ✓ SI units' : ' — expected 2.2e-9 H and 1.5e-12 F') : 'No tool calls'
      })
    }
  }

  // Turn discipline: after showing a prediction card, don't answer it yourself.
  {
    const ps = { stable: `${SOCRATIC}\nUse ask_prediction to make the learner commit to a prediction before explaining.` }
    const m0 = user('Quiz me: what happens when I add a shunt capacitor?')
    const r1 = await call('turn discipline', { system: ps, messages: [m0], tools: PREDICT_TOOLS, maxTokens: 1500 })
    if (r1 instanceof Error) fail('tool_wait', 'Waits after asking', 'tools', r1)
    else {
      const ask = calls(r1.message).find((x) => x.name === 'ask_prediction')
      let after = textOf(r1.message)
      if (ask) {
        const r2 = await call('turn discipline', {
          system: ps,
          messages: [m0, r1.message, { role: 'user', parts: [{ type: 'tool_result', callId: ask.id, name: ask.name, content: 'Prediction card shown to the learner. Stop here and wait for their answer.' }] }],
          tools: PREDICT_TOOLS, maxTokens: 1500
        })
        if (!(r2 instanceof Error)) after += '\n' + textOf(r2.message)
      }
      const reveals = /clockwise[^.?]*(constant|g\b|conductance)|(constant|conductance)[^.?]*clockwise/i.test(after.replace(/(counter|anti)[\s-]?clockwise/gi, ''))
      push({
        id: 'tool_wait', name: 'Waits after asking', category: 'tools',
        score: (ask ? 0.5 : 0) + (reveals ? 0 : 0.5),
        detail: `${ask ? 'used the prediction card' : 'asked in text instead of the card'}; ${reveals ? 'then GAVE the answer away' : 'did not reveal the answer'}`
      })
    }
  }

  const t3 = await call('tool restraint', { system: toolSys, messages: [user('Thanks! That makes sense.')], tools: BASIC_TOOLS, maxTokens: 800 })
  if (t3 instanceof Error) fail('tool_restraint', 'No needless tool calls', 'tools', t3)
  else {
    const called = calls(t3.message).length > 0
    push({ id: 'tool_restraint', name: 'No needless tool calls', category: 'tools', score: called ? 0.2 : 1, detail: called ? 'Called a tool for small talk' : 'Answered without tools' })
  }

  // ---- RF knowledge (concepts) -------------------------------------------------
  const kr = await call('RF knowledge', {
    system: { stable: 'You are an expert RF engineer. Output ONLY a JSON object.' },
    messages: [user(`Answer each multiple-choice question with one letter. Output only JSON like {"k1":"A",...}.\n${KNOWLEDGE.map((k) => `${k.id}: ${k.q}`).join('\n')}`)],
    maxTokens: 4000
  })
  if (kr instanceof Error) fail('knowledge', 'Concept questions', 'rf_knowledge', kr)
  else {
    const j = extractJson(textOf(kr.message))
    const wrong = KNOWLEDGE.filter((k) => String(j?.[k.id] ?? '').trim().toUpperCase().charAt(0) !== k.a)
    push({ id: 'knowledge', name: 'Concept questions', category: 'rf_knowledge', ms: kr.timing.totalMs, score: j ? (KNOWLEDGE.length - wrong.length) / KNOWLEDGE.length : 0, detail: j ? `${KNOWLEDGE.length - wrong.length}/${KNOWLEDGE.length} correct${wrong.length ? '. Wrong: ' + wrong.map((w) => w.id).join(', ') : ''}` : 'Did not return valid JSON' })
  }

  // ---- RF maths (no tools) -------------------------------------------------------
  const rr = await call('RF maths', {
    system: { stable: 'You are an expert RF engineer. Think carefully, then output ONLY a JSON object.' },
    messages: [user(`Answer each with a single number. Output only JSON like {"q1": 0.0, ...}.\n${MATH.map((r) => `${r.id}: ${r.text}`).join('\n')}`)],
    maxTokens: 6000
  })
  if (rr instanceof Error) fail('math', 'Calculations', 'rf_math', rr)
  else {
    const j = extractJson(textOf(rr.message))
    const wrong: string[] = []
    let right = 0
    for (const r of MATH) {
      const v = Number(j?.[r.id])
      if (Number.isFinite(v) && Math.abs(Math.abs(v) - r.answer) <= 0.03 * r.answer) right++
      else wrong.push(`${r.id} (got ${j?.[r.id] ?? '—'}, expected ${r.answer})`)
    }
    push({ id: 'math', name: 'Calculations', category: 'rf_math', ms: rr.timing.totalMs, score: j ? right / MATH.length : 0, detail: j ? `${right}/${MATH.length} correct${wrong.length ? '. Wrong: ' + wrong.join(', ') : ''}` : 'Did not return valid JSON' })
  }

  // ---- guiding -------------------------------------------------------------------
  const g1 = await call('guiding: withholds answers', { system: { stable: SOCRATIC }, messages: [user('Just give me the L and C values to match 25 Ω to 50 Ω at 1 GHz. I don\'t want to think about it.')], maxTokens: 1500 })
  if (g1 instanceof Error) fail('g_withhold', 'Withholds the answer', 'guiding', g1)
  else {
    const t = textOf(g1.message)
    const leaks = LEAKS.test(t)
    push({ id: 'g_withhold', name: 'Withholds the answer', category: 'guiding', score: (asksQuestion(t) ? 0.4 : 0) + (leaks ? 0 : 0.6), detail: `${asksQuestion(t) ? 'asked a guiding question' : 'no question'}; ${leaks ? 'GAVE AWAY the values' : 'withheld the values'}` })
  }

  const g2 = await call('guiding: corrects a wrong idea', { system: { stable: SOCRATIC }, messages: [user('I added a series inductor and the point moved counter-clockwise along the constant-r circle. That\'s right, isn\'t it?')], maxTokens: 1500 })
  if (g2 instanceof Error) fail('g_correct', 'Corrects a wrong idea', 'guiding', g2)
  else {
    const t = textOf(g2.message).trim()
    const agrees = /^(yes|yep|correct|that's (right|correct)|exactly|right|great|good job)\b/i.test(t)
    push({
      id: 'g_correct', name: 'Corrects a wrong idea', category: 'guiding',
      // Naming the right direction or making the learner reconsider it both count (Socratic tutors often do the latter).
      score: (agrees ? 0 : 0.4) + (asksQuestion(t) ? 0.3 : 0) + (saysClockwise(t) || challenges(t) ? 0.3 : 0),
      detail: `${agrees ? 'AGREED with the mistake' : 'did not just agree'}; ${asksQuestion(t) ? 'asked a question' : 'no question'}; ${saysClockwise(t) ? 'pointed to clockwise' : challenges(t) ? 'challenged the direction' : 'did not address the direction'}`
    })
  }

  const g3 = await call('guiding: hint', { system: { stable: SOCRATIC }, messages: [user('I\'m stuck matching 25 Ω to 50 Ω at 1 GHz. Can I have a hint?')], maxTokens: 1500 })
  if (g3 instanceof Error) fail('g_hint', 'Short hint, no answer', 'guiding', g3)
  else {
    const t = textOf(g3.message)
    const n = words(t)
    push({
      id: 'g_hint', name: 'Short hint, no answer', category: 'guiding',
      score: (asksQuestion(t) ? 0.3 : 0) + (LEAKS.test(t) ? 0 : 0.4) + (n <= 120 ? 0.3 : n <= 200 ? 0.15 : 0),
      detail: `${n} words; ${asksQuestion(t) ? 'asks a question' : 'no question'}; ${LEAKS.test(t) ? 'leaked values' : 'no values'}`
    })
  }

  // ---- learner tracking -------------------------------------------------------------
  const lmSys = { stable: `${SOCRATIC}\nTrack learning: after the learner answers, call record_evidence for the skill used, and log_misconception for a wrong mental model. Skill ids: ${SKILL_IDS.join(', ')}. Do not record anything you have not observed.` }
  const lm = await call('learner tracking', {
    system: lmSys,
    messages: [user('Let\'s practise.'), asst('Quick check: if you add a series capacitor, which way does the point move on the Smith chart?'), user('Clockwise along the constant-resistance circle.')],
    tools: LEARNER_TOOLS, maxTokens: 1500
  })
  if (lm instanceof Error) fail('lm_record', 'Records a wrong answer', 'learner', lm)
  else {
    const cs = calls(lm.message)
    const ev = cs.find((x) => x.name === 'record_evidence')
    const mc = cs.find((x) => x.name === 'log_misconception')
    // Right circle, wrong direction: "incorrect" is best, "partial" is defensible, "correct" is wrong.
    const skillOk = ev?.args.skill === 'lumped_moves'
    const score = skillOk && ev!.args.outcome === 'incorrect' ? (mc ? 1 : 0.85)
      : skillOk && ev!.args.outcome === 'partial' ? (mc ? 0.8 : 0.6)
        : skillOk || mc?.args.skill === 'lumped_moves' ? (mc ? 0.5 : 0.3)
          : cs.length ? 0.2 : 0
    push({ id: 'lm_record', name: 'Records a wrong answer', category: 'learner', score, detail: cs.length ? cs.map((x) => `${x.name}(${JSON.stringify(x.args).slice(0, 80)})`).join(', ') : 'Recorded nothing' })
  }
  const lm2 = await call('learner restraint', { system: lmSys, messages: [user('Hi! Ready when you are.')], tools: LEARNER_TOOLS, maxTokens: 800 })
  if (lm2 instanceof Error) fail('lm_restraint', 'Records only real evidence', 'learner', lm2)
  else {
    const cs = calls(lm2.message)
    push({ id: 'lm_restraint', name: 'Records only real evidence', category: 'learner', score: cs.length ? 0 : 1, detail: cs.length ? `Recorded progress from a greeting: ${cs.map((x) => x.name).join(', ')}` : 'Did not invent evidence' })
  }

  // ---- summaries ---------------------------------------------------------------------
  const transcript = [
    'Learner: I want to match a 25 Ω load to 50 Ω at 1 GHz.',
    'Tutor: Where does z = 0.5 sit relative to the g = 1 circle? Which element should go first?',
    'Learner: A shunt capacitor first.',
    'Tutor: Try it and watch: can a shunt move from z = 0.5 ever reach the r = 1 circle?',
    'Learner: Oh, it can\'t. Series first then. I used a series inductor of 3.98 nH and a shunt capacitor of 3.18 pF.',
    'Exercise "Match 25 Ω to 50 Ω": passed after 2 checks'
  ].join('\n')
  const sm = await call('summary', {
    system: { stable: 'You write short notes about Smith-chart tutoring sessions, for the tutor to read before the next session. Plain text only.' },
    messages: [user(`Summarise this session in at most 90 words: what was covered, what the learner did well, what they struggled with, and what to do next time.\n\n${transcript}`)],
    maxTokens: 2000
  })
  if (sm instanceof Error) fail('summary', 'Session summary', 'summary', sm)
  else {
    const t = textOf(sm.message)
    const facts: Array<[string, RegExp]> = [
      ['25 Ω load', /25/],
      ['series element', /series/i],
      ['shunt-first mistake', /shunt[^.]*(first|wrong|mistake|initially|tried)|(first|initially|tried)[^.]*shunt|order/i],
      ['exercise passed', /pass|succe|complet|matched/i],
      ['next step', /next|future|practi[cs]e|revisit|review/i]
    ]
    const hit = facts.filter(([, re]) => re.test(t))
    const n = words(t)
    push({
      id: 'summary', name: 'Session summary', category: 'summary',
      score: 0.8 * (hit.length / facts.length) + (n <= 110 ? 0.2 : n <= 160 ? 0.1 : 0),
      detail: `${n} words; covered ${hit.length}/${facts.length}: ${facts.map(([k, re]) => (re.test(t) ? '✓' : '✗') + k).join(', ')}`
    })
  }

  return finish()

  function finish(): BenchmarkReport {
    const scores: BenchmarkReport['scores'] = { overall: 0 }
    for (const a of ATTRIBUTES) {
      const xs = checks.filter((x) => x.category === a.id)
      if (xs.length) scores[a.id] = xs.reduce((s, x) => s + x.score, 0) / xs.length
    }
    scores.overall = fitScore(scores, ATTRIBUTES.map((a) => a.id))
    const pingOk = (checks.find((x) => x.id === 'ping')?.score ?? 0) > 0
    const errors = checks.filter((x) => x.error).length
    let tier: Tier = !pingOk ? 'Failed' : scores.overall >= 0.85 ? 'Excellent' : scores.overall >= 0.7 ? 'Good' : scores.overall >= 0.5 ? 'Usable' : 'Limited'
    if (pingOk && (scores.tools ?? 0) < 0.5 && (tier === 'Excellent' || tier === 'Good')) tier = 'Usable'
    if (errors >= 3) tier = 'Failed' // too many checks never ran: don't present a misleading grade

    const advice: string[] = []
    if (errors > 0) advice.push(`${errors} check(s) hit API errors (rate limit, quota or overload) even after retries, so these scores are incomplete. Run the benchmark again later.`)
    if (!pingOk) advice.push('The model could not be reached. Check the endpoint URL, API key and model name.')
    else if (errors < 3) {
      if ((scores.tools ?? 0) < 0.5) advice.push('Tool use is unreliable: the tutor cannot drive the chart, set exercises or track progress well. Use it for chat only, or pick a tool-capable model.')
      if ((scores.guiding ?? 0) < 0.7) advice.push('Tends to hand out answers or agree with mistakes. Set tutor style to "socratic" and push back when it does.')
      if ((scores.rf_knowledge ?? 0) < 0.75) advice.push('Gets some Smith-chart concepts wrong. Double-check its explanations against the chart.')
      if ((scores.learner ?? 0) < 0.6) advice.push('Progress tracking is weak: your skill levels may update less accurately (guardrails block made-up evidence).')
      if ((scores.summary ?? 0) < 0.6) advice.push('Session notes miss details, so the tutor will remember less between sessions.')
      if ((scores.speed ?? 0) < 0.4) advice.push('Slow responses. Fine for deliberate study; a faster model suits quick drills.')
      if (!advice.length) advice.push('Well suited as your Smith-chart tutor.')
    }
    return {
      ...meta,
      id: `run_${Date.now().toString(36)}`,
      suiteVersion: SUITE_VERSION,
      source: 'user',
      at: new Date().toISOString(),
      checks,
      metrics: {
        ttftMs,
        tokensPerSec,
        avgLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
        totalTokens: tokens || undefined
      },
      scores,
      incomplete: errors || undefined,
      tier,
      advice
    }
  }
}

/** Weighted score over the chosen attributes (renormalised), so rankings adapt to what the user cares about. */
export function fitScore(scores: BenchmarkReport['scores'], attrs: Attribute[]): number {
  let w = 0
  let s = 0
  for (const a of ATTRIBUTES) {
    if (!attrs.includes(a.id) || scores[a.id] === undefined) continue
    w += a.weight
    s += a.weight * (scores[a.id] as number)
  }
  return w ? s / w : 0
}
