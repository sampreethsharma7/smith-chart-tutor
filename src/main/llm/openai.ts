import type { ChatMessage, ChatRequest, Part, ProviderConfig } from '@shared/llm'
import { httpError, safeJson, sseData } from './sse'
import type { Emit } from './index'

/** OpenAI Chat Completions — also used for Ollama, LM Studio, OpenRouter, Groq, vLLM, ... */

function toOpenAI(system: string, messages: ChatMessage[]) {
  const out: Array<Record<string, unknown>> = [{ role: 'system', content: system }]
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = m.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('')
      const calls = m.parts.filter((p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call')
      out.push({
        role: 'assistant',
        content: text, // some servers (Ollama) reject null content
        ...(calls.length
          ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
          : {})
      })
    } else {
      for (const p of m.parts) if (p.type === 'tool_result') out.push({ role: 'tool', tool_call_id: p.callId, content: p.content })
      const text = m.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n')
      if (text) out.push({ role: 'user', content: text })
    }
  }
  return out
}

const baseOf = (cfg: ProviderConfig) => (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')

export async function openaiChat(
  cfg: ProviderConfig, key: string, req: ChatRequest, emit: Emit, signal: AbortSignal
): Promise<void> {
  const base = baseOf(cfg)
  const isOfficial = base.includes('api.openai.com')
  const system = req.system.dynamic ? `${req.system.stable}\n\n${req.system.dynamic}` : req.system.stable
  // Official OpenAI reasoning models count hidden reasoning against this limit; keep headroom.
  const maxTokens = Math.max(req.maxTokens ?? cfg.maxTokens ?? 2048, isOfficial ? 8192 : 0)
  const temperature = req.temperature ?? cfg.temperature
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: toOpenAI(system, req.messages),
    stream: true,
    stream_options: { include_usage: true },
    ...(isOfficial ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
    ...(temperature !== undefined ? { temperature } : {})
  }
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (key) headers.authorization = `Bearer ${key}`
  const t0 = performance.now()
  const res = await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal })
  if (!res.ok) throw await httpError(res, `OpenAI-compatible (${base})`)

  let ttft: number | null = null
  let firstByte: number | null = null
  let raw = '' // everything the model streamed, including <think> blocks
  let text = '' // what the learner sees
  const calls = new Map<number, { id: string; name: string; args: string }>()
  let finish = 'stop'
  const usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } = {}

  for await (const data of sseData(res, signal)) {
    if (data === '[DONE]') break
    const ev = safeJson(data) as any
    if (ev.error) throw new Error(`OpenAI-compatible: ${ev.error.message ?? JSON.stringify(ev.error)}`)
    if (ev.usage) {
      usage.inputTokens = ev.usage.prompt_tokens
      usage.outputTokens = ev.usage.completion_tokens
      usage.cachedInputTokens = ev.usage.prompt_tokens_details?.cached_tokens
    }
    const ch = ev.choices?.[0]
    if (!ch) continue
    const d = ch.delta ?? {}
    if (firstByte === null && (d.content || d.reasoning || d.reasoning_content || d.tool_calls)) firstByte = performance.now() - t0
    // OpenAI sends refusals in their own field; show them like normal text.
    if (typeof d.refusal === 'string' && d.refusal) d.content = (d.content ?? '') + d.refusal
    if (typeof d.content === 'string' && d.content) {
      // Reasoning models (qwen3, deepseek-r1…) inline <think>…</think>; hide it.
      raw += d.content
      let visible = raw.replace(/<think>[\s\S]*?(<\/think>\s*|$)/g, '')
      // Hold back a tag that may still be arriving ("<thi…").
      if (/<(t(h(i(nk?)?)?)?)?$/.test(visible)) visible = visible.replace(/<(t(h(i(nk?)?)?)?)?$/, '')
      if (visible.length > text.length) {
        if (ttft === null) ttft = performance.now() - t0
        emit({ type: 'text', delta: visible.slice(text.length) })
        text = visible
      }
    }
    for (const tc of d.tool_calls ?? []) {
      if (ttft === null) ttft = performance.now() - t0
      const idx = tc.index ?? 0
      const cur = calls.get(idx) ?? { id: '', name: '', args: '' }
      if (tc.id) cur.id = tc.id
      if (tc.function?.name) cur.name += tc.function.name
      if (tc.function?.arguments) {
        cur.args += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments)
      }
      calls.set(idx, cur)
    }
    if (ch.finish_reason) finish = ch.finish_reason
  }

  const finalVisible = raw.replace(/<think>[\s\S]*?(<\/think>\s*|$)/g, '')
  if (finalVisible.length > text.length) emit({ type: 'text', delta: finalVisible.slice(text.length) })
  text = finalVisible.trim()

  const parts: Part[] = []
  if (text) parts.push({ type: 'text', text })
  let i = 0
  for (const c of [...calls.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])) {
    const call = { type: 'tool_call' as const, id: c.id || `call_${Date.now()}_${i++}`, name: c.name, args: safeJson(c.args) }
    parts.push(call)
    emit({ type: 'tool_call', call })
  }

  emit({
    type: 'done',
    result: {
      message: { role: 'assistant', parts },
      stopReason: calls.size ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'stop' ? 'end' : 'other',
      usage,
      timing: { ttftMs: ttft, totalMs: performance.now() - t0, firstByteMs: firstByte ?? ttft }
    }
  })
}

export async function openaiModels(cfg: ProviderConfig, key: string): Promise<string[]> {
  const headers: Record<string, string> = {}
  if (key) headers.authorization = `Bearer ${key}`
  const res = await fetch(`${baseOf(cfg)}/models`, { headers })
  if (!res.ok) throw await httpError(res, 'OpenAI-compatible')
  const j = (await res.json()) as { data?: Array<{ id: string }> }
  return (j.data ?? []).map((m) => m.id).sort()
}
