// Build src/shared/benchmark-reference.json (the preset comparison shipped with
// the app) from one or more settings.json files produced by benchmark runs.
//
//   node scripts/export-reference.mjs <settings.json> [more settings.json...]
//
// Keeps the latest current-suite run per model. Provider ids and anything
// machine-specific other than the hardware note are dropped; keys are never in
// these files.
import { readFileSync, writeFileSync } from 'fs'

const SUITE = 4
const out = new Map()
for (const file of process.argv.slice(2)) {
  const s = JSON.parse(readFileSync(file, 'utf8'))
  for (const r of [...(s.benchmarkHistory ?? []), ...Object.values(s.benchmarks ?? {})]) {
    if ((r.suiteVersion ?? 1) < SUITE || r.tier === 'Failed') continue
    const key = `${r.kind}:${r.model}`
    if (!out.has(key) || out.get(key).at < r.at) out.set(key, r)
  }
}
const refs = [...out.values()]
  .map((r) => ({ ...r, providerId: `ref_${r.kind}_${r.model}`.replace(/[^a-zA-Z0-9_]/g, '_'), source: 'reference' }))
  .sort((a, b) => b.scores.overall - a.scores.overall)
writeFileSync(new URL('../src/shared/benchmark-reference.json', import.meta.url), JSON.stringify(refs, null, 1) + '\n')
console.log(`Wrote ${refs.length} reference results:`)
for (const r of refs) console.log(`  ${r.providerLabel.padEnd(28)} ${r.tier.padEnd(9)} overall ${Math.round(r.scores.overall * 100)}%`)
