import { capstoneProblem, makeCapstone, milestones, stageOf, titleOf, type CapstoneLoad, type CapstoneParts } from '@shared/capstone'
import { defineTools } from '../types'
import { LOAD_SCHEMA, parseLoad } from './chart'

export default defineTools([
  {
    name: 'set_capstone',
    description:
      'Set the learner\'s project (capstone): ONE concrete task tied to their goal, shown on their Progress page with the route to it. ' +
      'Describe it by its settings: what to match (their imported data, or a load model like their antenna), where (a frequency, or a band if their goal is about bandwidth), how well (max VSWR) and with what parts. ' +
      'The app works out the route (the skills it needs, each at a level) from those settings. Propose one early (first or second lesson) from their stated goal; ' +
      'with no goal, an antenna across its band is a good default. For interview prep or understanding without building, set judge: true. ' +
      'When the project is done, propose the next, harder one.',
    parameters: {
      type: 'object',
      properties: {
        use_their_data: { type: 'boolean', description: 'Match the data they imported (CST / VNA). Otherwise give load.' },
        load: { ...LOAD_SCHEMA, description: `${LOAD_SCHEMA.description} Default: the load on the chart now.` },
        f0_hz: { type: 'number', description: 'The project frequency (the band centre for a band)' },
        band_low_hz: { type: 'number' },
        band_high_hz: { type: 'number' },
        max_vswr: { type: 'number', description: 'e.g. 2 across a band, 1.5 at one frequency' },
        parts: { type: 'string', enum: ['lumped', 'lines', 'any'], description: 'lumped: L and C; lines: a line and a stub (PCB / microstrip); any: their choice. Default any.' },
        judge: { type: 'boolean', description: 'No build: the project is judging worked matches (interview prep)' },
        why: { type: 'string', description: 'One sentence to the learner tying it to their goal' },
        learner_asked: { type: 'boolean', description: 'They asked for this change (needed to replace a project they set themselves)' }
      },
      required: ['f0_hz', 'max_vswr', 'why']
    },
    activity: () => 'Setting your project',
    async run(a, ctx) {
      const p = ctx.profile()
      const now = p.capstone
      if (now && stageOf(p, now) !== 'done' && now.setBy === 'learner' && !a.learner_asked) {
        throw new Error(`The learner chose their project themselves on Progress ("${titleOf(now)}"). Keep it; change it only if they ask (then learner_asked: true).`)
      }
      const s = ctx.studio
      let load: CapstoneLoad
      if (a.use_their_data) {
        if (!s.datasets.length) throw new Error('They have no imported data yet. Give a load model instead (e.g. their antenna as kind antenna), or ask them to import their CST / VNA file first.')
        const lo = Math.min(Number(a.band_low_hz) || a.f0_hz, a.f0_hz), hi = Math.max(Number(a.band_high_hz) || a.f0_hz, a.f0_hz)
        const ds = s.datasets.find((d) => d.freqs[0] <= lo && d.freqs[d.freqs.length - 1] >= hi)
        if (!ds) throw new Error(`None of their data covers ${lo === hi ? 'that frequency' : 'that band'}: ${s.datasets.map((d) => `${d.name} (${(d.freqs[0] / 1e9).toFixed(3)}–${(d.freqs[d.freqs.length - 1] / 1e9).toFixed(3)} GHz)`).join(', ')}. Pick frequencies inside one of them.`)
        load = { kind: 'data', datasetName: ds.name }
      } else if (a.load) {
        load = parseLoad(a.load) as CapstoneLoad
      } else {
        const l = s.load
        if (l.kind === 'data') {
          const ds = s.datasets.find((d) => d.id === l.datasetId)
          if (!ds) throw new Error('The chart\'s load is data that is no longer loaded: give a load.')
          load = { kind: 'data', datasetName: ds.name }
        } else load = l
      }
      const band = a.band_low_hz && a.band_high_hz ? { low: Number(a.band_low_hz), high: Number(a.band_high_hz) } : undefined
      const c = makeCapstone({
        load, f0: Number(a.f0_hz), band, maxVswr: Number(a.max_vswr), parts: (['lumped', 'lines', 'any'].includes(a.parts) ? a.parts : 'any') as CapstoneParts,
        z0: s.z0, judge: !!a.judge, why: a.why ? String(a.why) : undefined, setBy: 'tutor', at: new Date().toISOString()
      })
      const problem = capstoneProblem(c, s.datasets)
      if (problem) throw new Error(`That project can't work: ${problem}.`)
      // A judge project whose route is already complete is done now (not at some later answer, which might be a slip).
      const saved = c.judge && stageOf({ ...p, capstone: c }, c) === 'done' ? { ...c, done: { at: c.at } } : c
      await ctx.updateProfile((pr) => ({ ...pr, capstone: saved }))
      const ms = milestones({ ...p, capstone: c }, c)
      return `Project saved and shown on their Progress page: "${titleOf(c)}". Route (${ms.filter((x) => x.met).length} of ${ms.length} met): ${ms.map((x) => `${x.met ? '✓' : '·'} ${x.words}`).join('; ')}. Tell them about it in a sentence or two, in their goal's terms; plan toward the next milestone.`
    }
  }
])
