import { z } from 'zod'
import { HARNESS_IDS, TEMPLATE_PLACEHOLDERS } from './contracts'
import type { HarnessManifestEntry, InstructionFileName, JsonTemplate } from './contracts'

const instructionFiles = ['AGENTS.md', 'CLAUDE.md', 'CONVENTIONS.md', '.goosehints'] as const satisfies readonly InstructionFileName[]
const allowed = new Set<string>(TEMPLATE_PLACEHOLDERS)
const SECRET = /^\{secret:[A-Z][A-Z0-9_]*\}$/

/** Every `{...}` in a template string must be a known placeholder or `{secret:NAME}`. */
export function placeholdersIn(value: string): string[] {
  return [...value.matchAll(/\{[^{}\s"]*\}/g)].map(([token]) => token)
}
const templateString = z.string().refine(
  value => placeholdersIn(value).every(token => allowed.has(token) || SECRET.test(token)),
  { message: 'Unknown template placeholder' },
)
const jsonTemplate: z.ZodType<JsonTemplate> = z.lazy(() => z.union([
  templateString, z.number(), z.boolean(), z.null(), z.array(jsonTemplate), z.record(z.string(), jsonTemplate),
]))
const templateValue = z.union([templateString, z.object({ json: jsonTemplate }).strict()])
const args = z.array(templateValue)
const env = z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), templateValue)

/** Placeholder tokens used anywhere inside a value. */
function tokens(value: unknown): string[] {
  if (typeof value === 'string') return placeholdersIn(value)
  if (Array.isArray(value)) return value.flatMap(tokens)
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => [...placeholdersIn(key), ...tokens(item)])
  return []
}

export const harnessManifestEntrySchema = z.object({
  id: z.enum(HARNESS_IDS),
  displayName: z.string().min(1),
  binary: z.string().min(1),
  installHint: z.string().min(1),
  knownVersion: z.string().nullable(),
  versionArgs: z.array(z.string()),
  helpArgs: z.array(z.string()),
  requiredHelpTokens: z.array(z.string().min(1)),
  defaultProtocol: z.enum(['acp-stdio', 'headless-json']),
  acp: z.object({ mode: z.enum(['native', 'adapter', 'none']), command: z.string().nullable(), args: z.array(z.string()) }).strict(),
  headless: z.object({ argsTemplate: args.min(1), output: z.enum(['json', 'stream-json', 'jsonl', 'text']) }).strict(),
  env: z.object({ cloud: env, lemonadeLocal: env }).strict(),
  lemonadeArgs: args,
  lemonadeBaseUrlStyle: z.enum(['openai-v1', 'root', 'unsupported']),
  instruction: z.object({ fileName: z.enum(instructionFiles).nullable(), args }).strict(),
  mcp: z.object({ method: z.enum(['cli-flag', 'config-override', 'env-config', 'none']), argsTemplate: args, env }).strict(),
  unverified: z.array(z.string()),
  license: z.string().nullable(),
  benefits: z.object({
    autonomy: z.enum(['low', 'medium', 'high']),
    tokenEfficiency: z.enum(['high', 'medium', 'heavy']),
    diffStrategy: z.enum(['unified-diff', 'search-replace', 'full-file-ast', 'whole-file']),
    subagentSupport: z.boolean(),
    lspIntegration: z.boolean(),
    localModelFriendly: z.boolean(),
    bestFor: z.array(z.string()).min(1),
    tradeoffs: z.string().min(1),
  }).strict(),
}).strict().superRefine((entry, ctx) => {
  const issue = (message: string): void => { ctx.addIssue({ code: 'custom', message: `${entry.id}: ${message}` }) }
  if (entry.acp.mode === 'none' && entry.defaultProtocol === 'acp-stdio') issue('acp.mode none cannot default to acp-stdio')
  if (entry.acp.mode !== 'none' && !entry.acp.command) issue('acp.command is required when ACP is available')
  if (!tokens(entry.headless.argsTemplate).includes('{prompt}')) issue('headless.argsTemplate must include {prompt}')
  const outsideLocal = [entry.headless, entry.env.cloud, entry.instruction, entry.mcp]
  if (tokens(outsideLocal).includes('{baseUrl}')) issue('{baseUrl} is only valid in env.lemonadeLocal and lemonadeArgs')
  if (tokens([entry.headless, entry.env, entry.lemonadeArgs, entry.instruction]).includes('{mcpUrl}')) issue('{mcpUrl} is only valid in mcp fields')
  if (tokens([entry.env, entry.lemonadeArgs, entry.instruction, entry.mcp]).includes('{prompt}')) issue('{prompt} is only valid in headless.argsTemplate')
  if (entry.mcp.method === 'none' && (entry.mcp.argsTemplate.length > 0 || Object.keys(entry.mcp.env).length > 0)) issue('mcp.method none must have no mcp args or env')
  if (entry.lemonadeBaseUrlStyle === 'unsupported' && Object.keys(entry.env.lemonadeLocal).length > 0) issue('unsupported Lemonade mode must have no lemonadeLocal env')
})

export const harnessManifestSchema = z.array(harnessManifestEntrySchema).length(HARNESS_IDS.length).superRefine((entries, ctx) => {
  const ids = entries.map(entry => entry.id)
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Duplicate harness id' })
})

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
/** Fails typecheck if the zod schema and the HarnessManifestEntry interface drift apart. */
export const manifestSchemaMatchesContract: Equal<z.infer<typeof harnessManifestEntrySchema>, HarnessManifestEntry> = true
