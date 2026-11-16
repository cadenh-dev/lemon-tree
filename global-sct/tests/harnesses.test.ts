import { deepStrictEqual, strictEqual, throws } from 'node:assert'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { HARNESS_IDS } from '../src/shared/contracts'
import { harnessManifestEntrySchema, harnessManifestSchema, parseHarnessManifest } from '../src/shared/harness-manifest'

async function loadRaw(): Promise<unknown[]> {
  return (JSON.parse(await readFile('../harnesses.json', 'utf8')) as { harnesses: unknown[] }).harnesses
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

test('rejects vault secret references in process arguments', async () => {
  const [opencode, , aider] = await loadRaw()
  const rejects = (entry: unknown): void => { strictEqual(harnessManifestEntrySchema.safeParse(entry).success, false) }
  rejects(variant(opencode, e => { e.headless = { argsTemplate: ['run', '--api-key', '{secret:OPENAI_API_KEY}', '{prompt}'], output: 'json' } }))
  rejects(variant(aider, e => { e.instruction = { fileName: 'CONVENTIONS.md', args: ['--read', '{secret:OPENAI_API_KEY}'] } }))
  rejects(variant(opencode, e => { e.headless = { argsTemplate: ['run', { json: { key: '{secret:OPENAI_API_KEY}' } }, '{prompt}'], output: 'json' } }))
})

test('reads the versioned file and the bare array of manifest version 0', async () => {
  const file = JSON.parse(await readFile('../harnesses.json', 'utf8')) as { manifestVersion: number; harnesses: unknown[] }
  strictEqual(file.manifestVersion, 1)
  deepStrictEqual(parseHarnessManifest(file).map(entry => entry.id), [...HARNESS_IDS])
  deepStrictEqual(parseHarnessManifest(file.harnesses), parseHarnessManifest(file))
  throws(() => parseHarnessManifest({ ...file, manifestVersion: 2 }))
  throws(() => parseHarnessManifest({ ...file, extra: true }))
})

test('requires each core harness one time and sets no upper limit on the entry count', async () => {
  const entries = await loadRaw()
  strictEqual(harnessManifestSchema.safeParse(entries.slice(1)).success, false)
  strictEqual(harnessManifestSchema.safeParse([...entries, entries[0]]).success, false)
  strictEqual(harnessManifestSchema.safeParse([]).success, false)
})

test('accepts x. extensions and known capabilities, and rejects other keys', async () => {
  const [opencode] = await loadRaw()
  const accepts = (entry: unknown): boolean => harnessManifestEntrySchema.safeParse(entry).success
  strictEqual(accepts(variant(opencode, e => { e.extensions = { 'x.team-note': { owner: 'lead', tags: ['a'] } }; e.capabilities = ['acp.v1', 'x.custom-probe'] })), true)
  strictEqual(accepts(variant(opencode, e => { e.extensions = { note: 'no prefix' } })), false)
  strictEqual(accepts(variant(opencode, e => { e.extensions = { 'x.': 1 } })), false)
  strictEqual(accepts(variant(opencode, e => { e.capabilities = ['acp.v9'] })), false)
})
