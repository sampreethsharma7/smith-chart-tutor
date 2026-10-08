import type { ChatMessage, ChatRequest, JsonSchema, Part, ProviderConfig } from '@shared/llm'
import { httpError, safeJson, sseData } from './sse'
import type { Emit } from './index'

const KEEP = new Set(['type', 'description', 'properties', 'required', 'items', 'enum', 'format', 'nullable', 'minimum', 'maximum'])

/** Gemini accepts an OpenAPI subset of JSON Schema. */
export function sanitize(s: JsonSchema): JsonSchema {
  const out: JsonSchema = {}
  for (const [k, v] of Object.entries(s)) {
    if (!KEEP.has(k)) continue
    if (k === 'type' && Array.isArray(v)) out.type = v.find((t) => t !== 'null') ?? 'string'
    else if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v as Record<string, JsonSchema>).map(([n, p]) => [n, sanitize(p)]))
    else if (k === 'items') out.items = sanitize(v as JsonSchema)
    else out[k] = v
  }
  // Gemini only accepts enums on strings: keep them for strings, drop them otherwise.
  if (Array.isArray(s.enum)) {
    if ((out.type ?? 'string') === 'string') out.enum = s.enum.map(String)
    else delete out.enum
  }
  return out
}

/** Gemini rejects OBJECT schemas with no properties; a tool without arguments must omit `parameters`. */
export const hasParams = (s: JsonSchema) => !!s.properties && Object.keys(s.properties).length > 0

function toGemini(messages: ChatMessage[]) {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.raw?.kind === 'gemini') return { role: 'model', parts: m.raw.data }
    return {
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: m.parts.map((p) => {
        if (p.type === 'text') return { text: p.text }
        if (p.type === 'tool_call') return { functionCall: { name: p.name, args: p.args } }
        return { functionResponse: { name: p.name, response: p.isError ? { error: p.content } : { result: p.content } } }
      })
    }
  })
}

const baseOf = (cfg: ProviderConfig) =>
  (cfg.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '')

export async function geminiChat(
  cfg: ProviderConfig, key: string, req: ChatRequest, emit: Emit, signal: AbortSignal
): Promise<void> {
  const system = req.system.dynamic ? `${req.system.stable}\n\n${req.system.dynamic}` : req.system.stable
  const temperature = req.temperature ?? cfg.temperature
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: system }] },
    contents: toGemini(req.messages),
    // Gemini 2.5+ spends hidden "thinking" tokens from this budget; leave room so answers aren't cut to nothing.
    generationConfig: { maxOutputTokens: Math.max(req.maxTokens ?? cfg.maxTokens ?? 4096, 8192), ...(temperature !== undefined ? { temperature } : {}) }
  }
  if (req.tools?.length) {
    body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, ...(hasParams(t.parameters) ? { parameters: sanitize(t.parameters) } : {}) })) }]
  }

  const t0 = performance.now()
  const res = await fetch(`${baseOf(cfg)}/models/${encodeURIComponent(cfg.model)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok) throw await httpError(res, 'Gemini')

  let ttft: number | null = null
  let firstByte: number | null = null
  let text = ''
  const rawParts: unknown[] = []
  const calls: Array<Extract<Part, { type: 'tool_call' }>> = []
  const usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } = {}
  let finish = 'STOP'

  for await (const data of sseData(res, signal)) {
    const ev = safeJson(data) as any
    if (ev.error) throw new Error(`Gemini: ${ev.error.message}`)
    if (ev.usageMetadata) {
      usage.inputTokens = ev.usageMetadata.promptTokenCount
      usage.outputTokens = (ev.usageMetadata.candidatesTokenCount ?? 0) + (ev.usageMetadata.thoughtsTokenCount ?? 0)
      usage.cachedInputTokens = ev.usageMetadata.cachedContentTokenCount
    }
    const cand = ev.candidates?.[0]
    if (!cand) continue
    if (cand.finishReason) finish = cand.finishReason
    for (const p of cand.content?.parts ?? []) {
      if (firstByte === null) firstByte = performance.now() - t0
      rawParts.push(p)
      if (typeof p.text === 'string' && !p.thought) {
        if (ttft === null) ttft = performance.now() - t0
        text += p.text
        emit({ type: 'text', delta: p.text })
      } else if (p.functionCall) {
        if (ttft === null) ttft = performance.now() - t0
        const call = {
          type: 'tool_call' as const,
          id: p.functionCall.id ?? `gcall_${Date.now()}_${calls.length}`,
          name: p.functionCall.name,
          args: p.functionCall.args ?? {}
        }
        calls.push(call)
        emit({ type: 'tool_call', call })
      }
    }
  }

  if (!text && !calls.length && /SAFETY|PROHIBITED|BLOCKLIST|RECITATION/.test(finish)) {
    throw new Error(`The model declined to answer this request (${finish}). Try rephrasing, or use another model for this.`)
  }
  const parts: Part[] = []
  if (text) parts.push({ type: 'text', text })
  parts.push(...calls)
  emit({
    type: 'done',
    result: {
      message: { role: 'assistant', parts, raw: { kind: 'gemini', data: rawParts } },
      stopReason: calls.length ? 'tool_use' : finish === 'MAX_TOKENS' ? 'max_tokens' : finish === 'STOP' ? 'end' : 'other',
      usage,
      timing: { ttftMs: ttft, totalMs: performance.now() - t0, firstByteMs: firstByte ?? ttft }
    }
  })
}

export async function geminiModels(cfg: ProviderConfig, key: string): Promise<string[]> {
  const res = await fetch(`${baseOf(cfg)}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } })
  if (!res.ok) throw await httpError(res, 'Gemini')
  const j = (await res.json()) as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> }
  return (j.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
}
