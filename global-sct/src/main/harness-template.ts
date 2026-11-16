// Harness manifest template engine (Wave 2A). Pure: no I/O, no process start, no vault call.
// The caller gives secret values in vars.secrets. This module never writes or logs a value.
import type { HarnessManifestEntry, JobBackend, JsonTemplate, TemplateValue } from '../shared/contracts'
import { placeholdersIn } from '../shared/harness-manifest'

/** Values the runner gives to template substitution. Secret values stay in memory. */
export interface TemplateVars {
  prompt: string
  model: string
  lemonadeUrl: string | null
  mcpUrl: string | null
  secrets: Record<string, string>
}

/** A template that the runner cannot resolve. The message names the token and never holds a secret value. */
export class TemplateError extends Error {
  name = 'TemplateError'
}

type BaseUrlStyle = HarnessManifestEntry['lemonadeBaseUrlStyle']

/**
 * Renders one manifest value. A `{ json }` value is substituted before JSON.stringify, so a prompt or a
 * secret with quotes, a backslash or a newline stays one valid JSON string.
 */
export function renderTemplateValue(value: TemplateValue, vars: TemplateVars, baseUrlStyle: BaseUrlStyle): string {
  if (typeof value === 'string') return substitute(value, vars, baseUrlStyle)
  return JSON.stringify(renderJson(value.json, vars, baseUrlStyle))
}

/**
 * Builds the headless argv in manifest order: headless args, instruction args, Lemonade args, then MCP args.
 * A Lemonade-local job is the only backend that takes lemonadeArgs, and a job without an MCP URL takes no mcp args.
 */
export function buildHeadlessArgs(entry: HarnessManifestEntry, vars: TemplateVars, backend: JobBackend): string[] {
  const templates = [...entry.headless.argsTemplate, ...entry.instruction.args]
  if (backend === 'amd-lemonade-local') templates.push(...entry.lemonadeArgs)
  if (vars.mcpUrl !== null) templates.push(...entry.mcp.argsTemplate)
  return templates.map(value => renderTemplateValue(value, vars, entry.lemonadeBaseUrlStyle))
}

/**
 * Builds the child env. The backend env applies first, then mcp.env when the job has an MCP URL.
 * One repeated key is legal only when both values are `{ json }`: the templates deep-merge, then render one time.
 */
export function buildEnv(entry: HarnessManifestEntry, vars: TemplateVars, backend: JobBackend): Record<string, string> {
  const templates = new Map(Object.entries(backend === 'amd-lemonade-local' ? entry.env.lemonadeLocal : entry.env.cloud))
  if (vars.mcpUrl !== null) {
    for (const [key, value] of Object.entries(entry.mcp.env)) {
      templates.set(key, combineEnvValue(key, templates.get(key), value))
    }
  }
  const env: Record<string, string> = {}
  for (const [key, value] of templates) env[key] = renderTemplateValue(value, vars, entry.lemonadeBaseUrlStyle)
  return env
}

function substitute(text: string, vars: TemplateVars, style: BaseUrlStyle): string {
  // placeholdersIn returns the tokens in source order, so indexOf finds the same occurrence for each token.
  let result = ''
  let cursor = 0
  for (const token of placeholdersIn(text)) {
    const at = text.indexOf(token, cursor)
    result += text.slice(cursor, at) + resolvePlaceholder(token, vars, style)
    cursor = at + token.length
  }
  return result + text.slice(cursor)
}

function renderJson(value: JsonTemplate, vars: TemplateVars, style: BaseUrlStyle): JsonTemplate {
  if (typeof value === 'string') return substitute(value, vars, style)
  if (Array.isArray(value)) return value.map(item => renderJson(item, vars, style))
  if (value !== null && typeof value === 'object') {
    const rendered: { [key: string]: JsonTemplate } = {}
    for (const [key, item] of Object.entries(value)) rendered[substitute(key, vars, style)] = renderJson(item, vars, style)
    return rendered
  }
  return value
}

function resolvePlaceholder(token: string, vars: TemplateVars, style: BaseUrlStyle): string {
  switch (token) {
    case '{prompt}': return vars.prompt
    case '{model}': return vars.model
    case '{baseUrl}': return lemonadeBaseUrl(vars.lemonadeUrl, style)
    case '{mcpUrl}': return mcpUrlValue(vars.mcpUrl)
    default: return secretValue(token, vars.secrets)
  }
}

function lemonadeBaseUrl(url: string | null, style: BaseUrlStyle): string {
  if (url === null) throw new TemplateError('Cannot render {baseUrl}: the job has no Lemonade URL.')
  if (style === 'unsupported') throw new TemplateError('Cannot render {baseUrl}: the harness has no Lemonade mode.')
  const root = url.replace(/\/+$/, '')
  return style === 'openai-v1' ? `${root}/v1` : root
}

function mcpUrlValue(url: string | null): string {
  if (url === null) throw new TemplateError('Cannot render {mcpUrl}: the job has no MCP attachment.')
  return url
}

function secretValue(token: string, secrets: Record<string, string>): string {
  const name = /^\{secret:([A-Z][A-Z0-9_]*)\}$/.exec(token)?.[1]
  if (name === undefined) throw new TemplateError(`Unknown template placeholder ${token}.`)
  const value = secrets[name]
  if (typeof value !== 'string') throw new TemplateError(`Cannot render ${token}: the vault has no secret value for ${name}.`)
  return value
}

function combineEnvValue(key: string, earlier: TemplateValue | undefined, later: TemplateValue): TemplateValue {
  if (earlier === undefined) return later
  if (typeof earlier === 'object' && typeof later === 'object') return { json: mergeJsonTemplate(earlier.json, later.json) }
  throw new TemplateError(`Env key ${key} has two values and one of them is not a { json } template.`)
}

function mergeJsonTemplate(earlier: JsonTemplate, later: JsonTemplate): JsonTemplate {
  if (!isJsonObject(earlier) || !isJsonObject(later)) return later
  const merged: { [key: string]: JsonTemplate } = { ...earlier }
  for (const [key, value] of Object.entries(later)) {
    merged[key] = key in earlier ? mergeJsonTemplate(earlier[key], value) : value
  }
  return merged
}

function isJsonObject(value: JsonTemplate): value is { [key: string]: JsonTemplate } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
