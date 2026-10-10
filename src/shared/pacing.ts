/**
 * Pacing: lessons move on. In the Riya re-run the first three lessons stayed on one point and one skill,
 * admittance was promised in three recaps before it came, and "Up next" named the same step for ten
 * lessons because nothing was asked that could move it. Two notes for the tutor's brief, each only
 * when it applies.
 */
import { lessonsOf, skillName, type Profile, type SkillId } from './profile'
import { milestones, stageOf } from './capstone'

/** The skill most of a lesson's graded answers were on, and whether every one of them was right. */
function lessonFocus(p: Profile, session: string): { skill: SkillId; clean: boolean; n: number } | null {
  const answers = (p.answers ?? []).filter((a) => a.session === session)
  if (answers.length < 2) return null
  const count = new Map<SkillId, number>()
  for (const a of answers) count.set(a.skill, (count.get(a.skill) ?? 0) + 1)
  const skill = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0]
  return { skill, clean: answers.every((a) => a.outcome === 'correct'), n: answers.length }
}

/** What their project or plan needs next, if it isn't `skill`. */
function nextElsewhere(p: Profile, skill: SkillId): SkillId | undefined {
  if (p.capstone && stageOf(p, p.capstone) === 'route') return milestones(p, p.capstone).find((m) => !m.met && m.skill !== skill)?.skill
  return p.nextFocus?.picks.find((x) => x.skill !== skill)?.skill
}

/**
 * The last two lessons were both mostly on one skill, reached their goal, and had no misses: time to
 * move on (at most a quick review of it).
 */
export function moveOnNote(p: Profile): string | null {
  const last = lessonsOf(p).slice(-2)
  if (last.length < 2 || !last.every((s) => s.goalReachedAt || s.outcome === 'completed')) return null
  const f = last.map((s) => lessonFocus(p, s.id))
  if (!f[0] || !f[1] || f[0].skill !== f[1].skill || !f[0].clean || !f[1].clean) return null
  const skill = f[0].skill
  const next = nextElsewhere(p, skill)
  return `Pacing: their last two lessons were both on ${skillName(skill)} (${skill}), goal reached, no misses. Move on this lesson${next ? `, to ${skillName(next)} (${next})` : ' to the next skill in your plan'}; ${skillName(skill)} only as a quick warm-up, if at all.`
}

/** How many lessons in a row "Up next" may point at a step without an item on it */
export const STUCK_AFTER = 3

/**
 * The next step of their project (or, without one, the first skill of your plan) has had no graded item
 * in the last STUCK_AFTER lessons since it was set: "Up next" has stood still. Set one that can move it.
 */
export function stuckNote(p: Profile): string | null {
  const lessons = lessonsOf(p)
  let skill: SkillId | undefined
  let since: string | undefined
  let what = ''
  if (p.capstone && stageOf(p, p.capstone) === 'route') {
    const m = milestones(p, p.capstone).find((x) => !x.met)
    skill = m?.skill
    since = p.capstone.at
    what = m ? `their project's next step (${m.words})` : ''
  } else if (!p.capstone || stageOf(p, p.capstone) === 'done') {
    skill = p.nextFocus?.picks[0]?.skill
    since = p.nextFocus?.at
    what = skill ? `the first skill of your plan (${skillName(skill)})` : ''
  }
  if (!skill || !since) return null
  const after = lessons.filter((s) => s.startedAt >= since!.slice(0, 19) || (s.endedAt ?? '') >= since!)
  const recent = after.slice(-STUCK_AFTER)
  if (recent.length < STUCK_AFTER) return null
  const ids = new Set(recent.map((s) => s.id))
  if ((p.answers ?? []).some((a) => a.skill === skill && ids.has(a.session))) return null
  return `Stuck: ${what} has had no graded item in their last ${STUCK_AFTER} lessons, so "Up next" hasn't moved. Set an item this lesson that can move it (see the brief for which items count).`
}
