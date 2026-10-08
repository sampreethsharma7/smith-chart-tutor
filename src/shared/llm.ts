/**
 * Provider-neutral chat types. Every adapter (Anthropic, OpenAI-compatible,
 * Gemini) translates to and from these, so the agent never cares which model
 * is behind it.
 */

export type ProviderKind = 'anthropic' | 'openai' | 'gemini'

/**
 * A connection is one provider account/endpoint and holds the API key
 * (one Anthropic key covers every Claude model, one Google key every Gemini model…).
 */
export interface Connection {
  id: string
  /** Preset id, e.g. "anthropic", "gemini", "ollama" */
  preset: string
  label: string
  kind: ProviderKind
  /** API endpoint override (Ollama, LM Studio, OpenRouter, custom) */
  baseUrl?: string
  /** Set by the main process; the key itself never leaves it */
  hasKey?: boolean
}

/** A model you can use as tutor: a model name on a connection. */
export interface ProviderConfig {
  id: string
  /** Display name, e.g. "Claude Sonnet 5.5", "Ollama · qwen2.5:7b" */
  label: string
  /** The connection (and so the key) this model uses */
  connectionId?: string
  /** Copied from the connection so adapters need only this object */
  kind: ProviderKind
  baseUrl?: string
  model: string
  temperature?: number
  maxTokens?: number
  /** Set by the main process from the connection's key */
  hasKey?: boolean
  /** Some local models cannot use tools; the agent falls back to chat-only mode */
  supportsTools?: boolean
}

export interface ConnectionPreset {
  id: string
  label: string
  kind: ProviderKind
  baseUrl?: string
  needsKey: boolean
  hint: string
  keyUrl?: string
  /** Shown first in the model picker, and added automatically when the connection is created */
  suggested: Array<{ model: string; label: string; note?: string }>
  /** Hide model ids that are not chat models (embeddings, audio, image…) */
  filter?: RegExp
}

export const CONNECTION_PRESETS: ConnectionPreset[] = [
  {
    id: 'anthropic', label: 'Anthropic (Claude)', kind: 'anthropic', needsKey: true,
    hint: 'One key for all Claude models.', keyUrl: 'https://console.anthropic.com/settings/keys',
    suggested: [
      { model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'best balance' },
      { model: 'claude-fable-5-1', label: 'Claude Fable 5.1', note: 'most capable' },
      { model: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'strong, higher cost' },
      { model: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', note: 'fast, cheap' }
    ]
  },
  {
    id: 'gemini', label: 'Google Gemini', kind: 'gemini', needsKey: true,
    hint: 'One key for all Gemini models.', keyUrl: 'https://aistudio.google.com/apikey',
    // "-latest" aliases keep working when Google retires a version.
    suggested: [
      { model: 'gemini-pro-latest', label: 'Gemini Pro (latest)', note: 'always the current Pro' },
      { model: 'gemini-flash-latest', label: 'Gemini Flash (latest)', note: 'fast, cheap' },
      { model: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)' },
      { model: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }
    ],
    filter: /embedding|aqa|imagen|veo|tts|audio|image|learnlm|live|native|lyria|robotics|computer-use|antigravity|deep-research|transcribe|nano-banana|customtools/i
  },
  {
    id: 'openai', label: 'OpenAI', kind: 'openai', needsKey: true,
    hint: 'One key for all OpenAI models.', keyUrl: 'https://platform.openai.com/api-keys',
    suggested: [{ model: 'gpt-5', label: 'GPT-5' }, { model: 'gpt-5-mini', label: 'GPT-5 mini' }],
    filter: /embedding|whisper|tts|dall-e|image|audio|realtime|moderation|transcribe|search|babbage|davinci/i
  },
  {
    id: 'openrouter', label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true,
    hint: 'One key, hundreds of models from many vendors.', keyUrl: 'https://openrouter.ai/keys', suggested: []
  },
  {
    id: 'ollama', label: 'Ollama (local)', kind: 'openai', baseUrl: 'http://localhost:11434/v1', needsKey: false,
    hint: 'Free and offline. Pull models with `ollama pull <model>`; pick tool-capable ones (qwen2.5, qwen3, llama3.1…).',
    suggested: [], filter: /embed/i
  },
  {
    id: 'lmstudio', label: 'LM Studio (local)', kind: 'openai', baseUrl: 'http://localhost:1234/v1', needsKey: false,
    hint: 'Start the LM Studio local server first.', suggested: [], filter: /embed/i
  },
  {
    id: 'custom', label: 'Custom (OpenAI-compatible)', kind: 'openai', baseUrl: 'http://localhost:8000/v1', needsKey: false,
    hint: 'Any OpenAI-compatible endpoint: vLLM, Groq, Together, a company gateway… Set the endpoint and key.', suggested: []
  }
]

export const presetOf = (c: Pick<Connection, 'preset'>) => CONNECTION_PRESETS.find((p) => p.id === c.preset) ?? CONNECTION_PRESETS[CONNECTION_PRESETS.length - 1]

/** Friendly display name for a model on a connection. */
export function modelLabel(conn: Pick<Connection, 'preset' | 'label'>, model: string): string {
  const s = presetOf(conn).suggested.find((x) => x.model === model)
  if (s) return s.label
  if (conn.preset === 'ollama' || conn.preset === 'lmstudio') return `${conn.preset === 'ollama' ? 'Ollama' : 'LM Studio'} · ${model}`
  return model
}

export interface JsonSchema {
  type?: string | string[]
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: Array<string | number>
  [k: string]: unknown
}

export interface ToolSpec {
  name: string
  description: string
  parameters: JsonSchema
}

export type Part =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; callId: string; name: string; content: string; isError?: boolean }

export interface ChatMessage {
  role: 'user' | 'assistant'
  parts: Part[]
  /** Provider-native content echoed back verbatim when required (e.g. Gemini thought signatures) */
  raw?: { kind: ProviderKind; data: unknown }
}

export interface SystemPrompt {
  /** Stable part (cached when the provider supports it) */
  stable: string
  /** Per-turn part: learner snapshot, chart state, ... */
  dynamic?: string
}

export interface ChatRequest {
  providerId: string
  system: SystemPrompt
  messages: ChatMessage[]
  tools?: ToolSpec[]
  maxTokens?: number
  temperature?: number
}

export interface Usage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
}

export interface ChatResult {
  message: ChatMessage
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other'
  usage: Usage
  /** ttftMs = first visible text/tool call; firstByteMs = first output of any kind, incl. hidden reasoning */
  timing: { ttftMs: number | null; totalMs: number; firstByteMs?: number | null }
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: Extract<Part, { type: 'tool_call' }> }
  | { type: 'done'; result: ChatResult }
  | { type: 'error'; message: string }

export const textOf = (m: ChatMessage): string =>
  m.parts.filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('')
