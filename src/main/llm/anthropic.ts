import type { ChatMessage, ChatRequest, Part, ProviderConfig, StreamEvent } from '@shared/llm'
import { httpError, safeJson, sseData } from './sse'
import type { Emit } from './index'

const VERSION = '2023-06-01'

function toAnthropic(messages: ChatMessage[]) {
  return messages.map((m) => ({
    role: m.role,
    content: m.parts.map((p) => {
      if (p.type === 'text') return { type: 'text', text: p.text }
      if (p.type === 'tool_call') return { type: 'tool_use', id: p.id, name: p.name, input: p.args }
      return { type: 'tool_result', tool_use_id: p.callId, content: p.content, is_error: p.isError || undefined }
    })
  }))
}

export async function anthropicChat(
  cfg: ProviderConfig, key: string, req: ChatRequest, emit: Emit, signal: AbortSignal
): Promise<void> {
  const base = (cfg.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')
  const system: Array<Record<string, unknown>> = [
    { type: 'text', text: req.system.stable, cache_control: { type: 'ephemeral' } }
  ]
  if (req.system.dynamic) system.push({ type: 'text', text: req.system.dynamic })

  const tools = req.tools?.map((t, i, arr) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
    ...(i === arr.length - 1 ? { cache_control: { type: 'ephemeral' } } : {})
  }))

  const body = {
    model: cfg.model,
    max_tokens: req.maxTokens ?? cfg.maxTokens ?? 2048,
    temperature: req.temperature ?? cfg.temperature,
    system,
    messages: toAnthropic(req.messages),
    tools: tools?.length ? tools : undefined,
    stream: true
  }

  const t0 = performance.now()
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': VERSION },
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok) throw await httpError(res, 'Anthropic')

  let ttft: number | null = null
  let firstByte: number | null = null
  const parts: Part[] = []
  const pendingJson = new Map<number, string>()
  const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
  let stop = 'end_turn'

  for await (const data of sseData(res, signal)) {
    const ev = safeJson(data) as any
    if (process.env.SMITH_DEBUG_SSE) console.log('[sse]', ev.type, ev.content_block?.type ?? ev.delta?.type ?? '', ev.delta?.stop_reason ?? '')
    switch (ev.type) {
      case 'message_start':
        usage.inputTokens = ev.message?.usage?.input_tokens ?? 0
        usage.cachedInputTokens = ev.message?.usage?.cache_read_input_tokens ?? 0
        break
      case 'content_block_start': {
        const b = ev.content_block
        if (b.type === 'text') parts[ev.index] = { type: 'text', text: '' }
        else if (b.type === 'tool_use') {
          parts[ev.index] = { type: 'tool_call', id: b.id, name: b.name, args: {} }
          pendingJson.set(ev.index, '')
        }
        break
      }
      case 'content_block_delta': {
        if (firstByte === null) firstByte = performance.now() - t0
        const p = parts[ev.index]
        if (ev.delta.type === 'text_delta' && p?.type === 'text') {
          if (ttft === null) ttft = performance.now() - t0
          p.text += ev.delta.text
          emit({ type: 'text', delta: ev.delta.text })
        } else if (ev.delta.type === 'input_json_delta') {
          if (ttft === null) ttft = performance.now() - t0
          pendingJson.set(ev.index, (pendingJson.get(ev.index) ?? '') + ev.delta.partial_json)
        }
        break
      }
      case 'content_block_stop': {
        const p = parts[ev.index]
        if (p?.type === 'tool_call') {
          p.args = safeJson(pendingJson.get(ev.index) ?? '')
          emit({ type: 'tool_call', call: p })
        }
        break
      }
      case 'message_delta':
        if (ev.delta?.stop_reason) stop = ev.delta.stop_reason
        if (ev.usage?.output_tokens) usage.outputTokens = ev.usage.output_tokens
        break
      case 'error':
        throw new Error(`Anthropic: ${ev.error?.message ?? 'stream error'}`)
    }
  }

  // The model's safety system can decline a request outright (stop_reason "refusal", no content).
  if (stop === 'refusal' && !parts.some(Boolean)) {
    throw new Error('The model declined to answer this request (refusal). Try rephrasing, or use another model for this.')
  }

  const done: StreamEvent = {
    type: 'done',
    result: {
      message: { role: 'assistant', parts: parts.filter(Boolean) },
      stopReason: stop === 'tool_use' ? 'tool_use' : stop === 'max_tokens' ? 'max_tokens' : stop === 'end_turn' ? 'end' : stop === 'refusal' ? 'refusal' : 'other',
      usage,
      timing: { ttftMs: ttft, totalMs: performance.now() - t0, firstByteMs: firstByte ?? ttft }
    }
  }
  emit(done)
}

export async function anthropicModels(cfg: ProviderConfig, key: string): Promise<string[]> {
  const base = (cfg.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')
  const res = await fetch(`${base}/v1/models?limit=100`, {
    headers: { 'x-api-key': key, 'anthropic-version': VERSION }
  })
  if (!res.ok) throw await httpError(res, 'Anthropic')
  const j = (await res.json()) as { data: Array<{ id: string }> }
  return j.data.map((m) => m.id)
}
