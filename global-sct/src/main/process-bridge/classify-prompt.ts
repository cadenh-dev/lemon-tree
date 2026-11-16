import type { PromptIntent, PromptRole } from '../../shared/contracts'

type Depth = PromptIntent['depth']

interface RoleRule { role: PromptRole; keywords: readonly string[] }
interface RoleMatch { role: PromptRole; keyword: string | null }
interface DepthStep { delta: number; describe: string }

// Rule order decides the role. The first rule with a keyword match wins, and the keyword list order
// decides which keyword goes in the evidence.
const ROLE_RULES: readonly RoleRule[] = [
  { role: 'review', keywords: ['review', 'audit', 'critique', 'code review', 'find bugs', 'look over'] },
  { role: 'test', keywords: ['write tests', 'add tests', 'add a test', 'unit test', 'test coverage', 'reproduce', 'failing test'] },
  { role: 'research', keywords: ['research', 'investigate', 'compare', 'survey', 'look up', 'find out', 'what is', 'how does', 'why does'] },
  { role: 'design', keywords: ['design', 'architect', 'architecture', 'plan', 'propose', 'proposal', 'tradeoff', 'trade-off', 'rfc', 'spec'] },
  { role: 'implementation', keywords: ['implement', 'add', 'build', 'create', 'fix', 'refactor', 'migrate', 'write', 'update', 'change', 'remove', 'rename', 'port'] }
]

const BREADTH_WORDS: readonly string[] = ['across', 'all', 'every', 'multiple', 'several', 'refactor', 'migrate', 'module', 'modules']
const RISK_WORDS: readonly string[] = ['architecture', 'security', 'breaking', 'migration', 'concurrency', 'protocol', 'schema', 'data loss']
const SMALL_WORDS: readonly string[] = ['typo', 'rename', 'format', 'one line', 'comment', 'wording']

const BASE_DEPTH = 2
const DEPTH_LEVELS = [1, 2, 3, 4, 5] as const
const LONG_PROMPT = 600
const LIST_LINES = 3
const LIST_MARKER = /^(?:[-*]|\d+\.)/

/**
 * Maps a user prompt to an intent. The result is deterministic and reads the text only: no I/O, no clock,
 * no model. This is not a process-role classifier; process roles come from agtop.
 */
export function classifyPrompt(prompt: string): PromptIntent {
  if (prompt.trim() === '') return { role: 'general', depth: 1, evidence: ['empty prompt'] }
  const match = matchRole(prompt.toLowerCase())
  const steps = depthSteps(prompt)
  return {
    role: match.role,
    depth: clampDepth(steps.reduce((depth, step) => depth + step.delta, BASE_DEPTH)),
    evidence: [roleEvidence(match), ...steps.map(step => step.describe)]
  }
}

function matchRole(text: string): RoleMatch {
  for (const rule of ROLE_RULES) {
    const keyword = rule.keywords.find(word => hasWord(text, word))
    if (keyword !== undefined) return { role: rule.role, keyword }
  }
  return { role: 'general', keyword: null }
}

function roleEvidence({ role, keyword }: RoleMatch): string {
  return keyword === null ? `role:${role} no keyword` : `role:${role} keyword "${keyword}"`
}

// Each depth rule applies at most one time, in this order.
function depthSteps(prompt: string): DepthStep[] {
  const text = prompt.toLowerCase()
  const steps: DepthStep[] = []
  const breadth = BREADTH_WORDS.find(word => hasWord(text, word))
  if (breadth !== undefined) steps.push({ delta: 1, describe: `depth:+1 breadth "${breadth}"` })
  const risk = RISK_WORDS.find(word => hasWord(text, word))
  if (risk !== undefined) steps.push({ delta: 1, describe: `depth:+1 risk "${risk}"` })
  if (isLargePrompt(prompt)) steps.push({ delta: 1, describe: 'depth:+1 size' })
  const small = SMALL_WORDS.find(word => hasWord(text, word))
  if (small !== undefined) steps.push({ delta: -1, describe: `depth:-1 small "${small}"` })
  return steps
}

function isLargePrompt(prompt: string): boolean {
  if (prompt.length > LONG_PROMPT) return true
  return prompt.split('\n').filter(line => LIST_MARKER.test(line.trim())).length >= LIST_LINES
}

function clampDepth(value: number): Depth {
  for (const level of DEPTH_LEVELS) if (level >= value) return level
  return 5
}

// Whole words and whole phrases only, so 'address' does not match 'add'.
function hasWord(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}\\b`).test(text)
}
