import { deepStrictEqual, strictEqual } from 'node:assert'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { HARNESS_IDS } from '../src/shared/contracts'
import { harnessManifestEntrySchema, harnessManifestSchema } from '../src/shared/harness-manifest'

async function loadRaw(): Promise<unknown[]> {
  return JSON.parse(await readFile('../harnesses.json', 'utf8')) as unknown[]
}

function variant(base: unknown, change: (entry: Record<string, unknown>) => void): unknown {
  const copy = structuredClone(base) as Record<string, unknown>
  change(copy)
  return copy
}

test('validates all six locked harness definitions', async () => {
  const manifest = harnessManifestSchema.parse(await loadRaw())
  deepStrictEqual(manifest.map(entry => entry.id), [...HARNESS_IDS])
})

test('rejects unknown placeholders, misplaced placeholders and inconsistent ACP settings', async () => {
  const [opencode, , aider] = await loadRaw()
  const rejects = (entry: unknown): void => { strictEqual(harnessManifestEntrySchema.safeParse(entry).success, false) }
  rejects(variant(opencode, e => { e.headless = { argsTemplate: ['run', '{promt}'], output: 'json' } }))
  rejects(variant(opencode, e => { e.headless = { argsTemplate: ['run', '--format', 'json'], output: 'json' } }))
  rejects(variant(aider, e => { e.env = { cloud: { OPENAI_API_BASE: '{baseUrl}' }, lemonadeLocal: {} } }))
  rejects(variant(aider, e => { e.instruction = { fileName: 'CONVENTIONS.md', args: ['--read', '{mcpUrl}'] } }))
  rejects(variant(aider, e => { e.defaultProtocol = 'acp-stdio' }))
  rejects(variant(opencode, e => { e.extra = true }))
})

test('accepts vault secret references and JSON templates', async () => {
  const [opencode] = await loadRaw()
  const ok = harnessManifestEntrySchema.safeParse(variant(opencode, e => {
    e.env = { cloud: { OPENAI_API_KEY: '{secret:OPENAI_API_KEY}', CONFIG: { json: { model: '{model}', nested: [1, true, null] } } }, lemonadeLocal: {} }
  }))
  strictEqual(ok.success, true)
})
