#!/usr/bin/env node
// Audit: what's going wrong, most common first. Reads (never changes) the app's data folder:
//   - reports/*.json      problems flagged with ⚑ in the app (with screenshots)
//   - issues.jsonl        faults the app logged as they happened
//   - conversations/, design/*.chat.json   saved chats, replayed through the same checks
//   - profiles/*.json     lesson transcripts (text checks only: they keep no tool calls)
// Usage: npm run audit [-- <data folder>] [-- --since 2026-10-01]
// Default folder: %APPDATA%/smith-tutor/data (or ~/.config / ~/Library equivalents).
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { auditTurn, turnsOf, ISSUE_LABEL } from '../src/shared/issues.ts'

const args = process.argv.slice(2)
const sinceArg = args.indexOf('--since')
const since = sinceArg >= 0 ? args[sinceArg + 1] : ''
const folderArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--since')
const defaultRoot = process.platform === 'win32'
  ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'smith-tutor', 'data')
  : process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'smith-tutor', 'data')
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'smith-tutor', 'data')
const root = folderArg ?? defaultRoot
if (!existsSync(root)) {
  console.error(`No data folder at ${root}. Pass the folder: npm run audit -- <path>`)
  process.exit(1)
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const files = (dir, test) => (existsSync(dir) ? readdirSync(dir).filter(test).map((f) => join(dir, f)) : [])
const recent = (at) => !since || (at ?? '') >= since

/** Every finding, from every source; the same fault seen twice (logged live and found in the saved chat) counts once. */
const findings = []
const seen = new Set()
const add = (f) => {
  const key = `${f.kind}|${f.agent}|${(f.excerpt ?? f.detail).slice(0, 120)}`
  if (seen.has(key)) return
  seen.add(key)
  findings.push(f)
}

// 1. Flagged by the person: listed in full, they come first.
const reports = files(join(root, 'reports'), (f) => f.endsWith('.json'))
  .map((p) => ({ p, r: readJson(p) }))
  .filter(({ r }) => r && recent(r.at))

// 2. Logged live.
let logged = 0
for (const name of ['issues.old.jsonl', 'issues.jsonl']) {
  const p = join(root, name)
  if (!existsSync(p)) continue
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const x = JSON.parse(line)
      if (!recent(x.at)) continue
      logged++
      add({ ...x, source: 'logged live' })
    } catch { /* a torn last line */ }
  }
}

// 3. Saved chats, replayed. Tool names come from the chats themselves.
const chats = [
  ...files(join(root, 'conversations'), (f) => f.endsWith('.json')).map((p) => ({ p, agent: 'tutor' })),
  ...files(join(root, 'design'), (f) => f.endsWith('.chat.json')).map((p) => ({ p, agent: 'design' }))
]
const toolNames = new Set(['get_chart_state', 'match_options', 'propose_designs', 'apply_design', 'check_network', 'annotate_chart', 'what_if', 'rf_calculate', 'analyze_sweep', 'set_scenario'])
const loaded = chats.map((c) => ({ ...c, chat: readJson(c.p) })).filter((c) => c.chat?.history)
for (const c of loaded) for (const m of c.chat.history) for (const part of m.parts) if (part.type === 'tool_call') toolNames.add(part.name)
let turns = 0
for (const c of loaded) {
  if (!recent(c.chat.savedAt)) continue
  for (const t of turnsOf(c.chat.history)) {
    turns++
    for (const f of auditTurn(t, [...toolNames])) add({ ...f, agent: c.agent, at: c.chat.savedAt, source: `saved chat (${c.agent})`, opening: t.opening })
  }
}

// 4. Lesson transcripts: text only.
let transcripts = 0
for (const p of files(join(root, 'profiles'), (f) => f.endsWith('.json'))) {
  const prof = readJson(p)
  for (const s of prof?.sessions ?? []) {
    if (!recent(s.startedAt)) continue
    transcripts++
    for (const e of s.transcript ?? []) {
      if (e.role !== 'tutor') continue
      for (const f of auditTurn({ texts: [e.text], tools: [] }, [...toolNames])) {
        // Without tool calls, claims can't be checked against what happened: keep the text-only checks.
        if (f.kind === 'tool-name' || f.kind === 'escaped-newline') add({ ...f, agent: 'tutor', model: e.model, at: e.at, source: 'lesson transcript' })
      }
    }
  }
}

// ---- report ----
const out = []
out.push(`# Audit of ${root}${since ? ` since ${since}` : ''}`)
out.push(`Read: ${reports.length} flagged report(s), ${logged} logged fault(s), ${turns} saved chat turn(s), ${transcripts} lesson transcript(s).`)
out.push('')
if (reports.length) {
  out.push(`## Flagged by you (${reports.length}), newest first`)
  for (const { p, r } of reports.sort((a, b) => (b.r.at ?? '').localeCompare(a.r.at ?? ''))) {
    out.push(`- ${r.at?.slice(0, 16).replace('T', ' ')} · ${r.about} · ${r.flaggedMessage?.model ?? r.activeModel ?? 'no model'}${r.note ? ` · "${r.note}"` : ''}`)
    if (r.flaggedMessage?.text) out.push(`  > ${r.flaggedMessage.text.replace(/\s+/g, ' ').slice(0, 300)}`)
    out.push(`  file: ${p}${r.screenshot ? ` (+ ${r.screenshot})` : ''}`)
  }
  out.push('')
}
const byKind = new Map()
for (const f of findings) {
  const k = f.kind
  if (!byKind.has(k)) byKind.set(k, [])
  byKind.get(k).push(f)
}
const ranked = [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)
out.push(`## Faults, most common first (${findings.length})`)
if (!ranked.length) out.push('None found.')
for (const [kind, list] of ranked) {
  const models = new Map()
  for (const f of list) models.set(f.model ?? '?', (models.get(f.model ?? '?') ?? 0) + 1)
  const details = new Map()
  for (const f of list) details.set(f.detail, (details.get(f.detail) ?? 0) + 1)
  out.push(`### ${ISSUE_LABEL[kind] ?? kind}: ${list.length}`)
  out.push(`- by model: ${[...models.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(', ')}`)
  out.push(`- most common: ${[...details.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d, n]) => `${d} (${n})`).join('; ')}`)
  for (const f of list.slice(-3)) out.push(`- e.g. [${f.agent}, ${f.source}${f.at ? `, ${String(f.at).slice(0, 10)}` : ''}] ${(f.excerpt ?? f.detail).slice(0, 260)}`)
  out.push('')
}
console.log(out.join('\n'))
