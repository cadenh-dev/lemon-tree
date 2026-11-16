import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { buildEnv, buildHeadlessArgs, renderTemplateValue, TemplateError } from '../src/main/harness-template.ts'
import type { TemplateVars } from '../src/main/harness-template.ts'
import type { HarnessId, HarnessManifestEntry, TemplateValue } from '../src/shared/contracts.ts'
import { parseHarnessManifest, placeholdersIn } from '../src/shared/harness-manifest.ts'

const vars: TemplateVars = {
  prompt: 'Edit the file.',
  model: 'test-model',
  lemonadeUrl: 'http://127.0.0.1:13305',
  mcpUrl: 'http://127.0.0.1:9/mcp/job-1',
  secrets: {
    ANTHROPIC_API_KEY: 'LEMON_TREE_SYNTHETIC_SECRET_1',
    OPENAI_API_KEY: 'LEMON_TREE_SYNTHETIC_SECRET_2',
    DEEPSEEK_API_KEY: 'LEMON_TREE_SYNTHETIC_SECRET_3',
  },
}

test('replaces {prompt} and {model} in a plain string and returns a string without a placeholder as it is', () => {
  assert.equal(renderTemplateValue('Run {model} with: {prompt}', vars, 'openai-v1'), 'Run test-model with: Edit the file.')
  assert.equal(renderTemplateValue('--format json', vars, 'openai-v1'), '--format json')
})

test('renders a { json } value in string leaves and object keys and keeps numbers, booleans, null and arrays', () => {
  const value: TemplateValue = { json: {
    key: '{model}',
    '{prompt}': ['{model}', 7, true, null],
    nested: { list: [{ '{model}': '{prompt}' }] },
  } }
  assert.deepEqual(JSON.parse(renderTemplateValue(value, vars, 'openai-v1')), {
    key: 'test-model',
    'Edit the file.': ['test-model', 7, true, null],
    nested: { list: [{ 'test-model': 'Edit the file.' }] },
  })
})

test('keeps a prompt with a double quote, a backslash and a newline valid inside a { json } value', () => {
  const prompt = 'Say "hello" to C:\\temp\nand stop'
  const rendered = renderTemplateValue({ json: { prompt: '{prompt}' } }, { ...vars, prompt }, 'openai-v1')
  assert.equal((JSON.parse(rendered) as { prompt: string }).prompt, prompt)
})

test('{baseUrl} gives <url>/v1 for style openai-v1 and the bare URL for style root, without a trailing slash', () => {
  assert.equal(renderTemplateValue('{baseUrl}', vars, 'openai-v1'), 'http://127.0.0.1:13305/v1')
  assert.equal(renderTemplateValue('{baseUrl}', { ...vars, lemonadeUrl: 'http://127.0.0.1:13305/' }, 'openai-v1'), 'http://127.0.0.1:13305/v1')
  assert.equal(renderTemplateValue('{baseUrl}', vars, 'root'), 'http://127.0.0.1:13305')
  assert.equal(renderTemplateValue('{baseUrl}', { ...vars, lemonadeUrl: 'http://127.0.0.1:13305/' }, 'root'), 'http://127.0.0.1:13305')
})

test('{baseUrl} with a null lemonadeUrl or with style unsupported throws TemplateError', () => {
  assert.throws(() => renderTemplateValue('{baseUrl}', { ...vars, lemonadeUrl: null }, 'openai-v1'), TemplateError)
  assert.throws(() => renderTemplateValue('{baseUrl}', vars, 'unsupported'), TemplateError)
})

test('{secret:NAME} resolves from vars.secrets, and a missing secret throws TemplateError without a secret value', () => {
  assert.equal(renderTemplateValue('key={secret:OPENAI_API_KEY}', vars, 'openai-v1'), 'key=LEMON_TREE_SYNTHETIC_SECRET_2')
  assert.throws(() => renderTemplateValue('{secret:OPENCODE_ZEN_KEY}', vars, 'openai-v1'), (error: unknown) => {
    assert.ok(error instanceof TemplateError)
    assert.match(error.message, /OPENCODE_ZEN_KEY/)
    for (const value of Object.values(vars.secrets)) assert.equal(error.message.includes(value), false)
    return true
  })
})

test('{mcpUrl} with a null mcpUrl throws TemplateError, and the builders leave out the mcp parts', async () => {
  const local: TemplateVars = { ...vars, mcpUrl: null }
  assert.throws(() => renderTemplateValue('{mcpUrl}', local, 'openai-v1'), TemplateError)
  assert.deepEqual(buildHeadlessArgs(await entryOf('claude-code'), local, 'cloud-api'),
    ['-p', 'Edit the file.', '--output-format', 'stream-json', '--verbose'])
  const env = buildEnv(await entryOf('opencode'), local, 'amd-lemonade-local')
  const content = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as Record<string, unknown>
  assert.equal('mcp' in content, false)
  assert.equal(content.model, 'lemonade/test-model')
})

test('buildHeadlessArgs gives headless, instruction, lemonadeArgs (lemonade-local only) and mcp arguments in order', async () => {
  assert.deepEqual(buildHeadlessArgs(await entryOf('aider'), vars, 'cloud-api'),
    ['--message', 'Edit the file.', '--yes-always', '--no-auto-commits', '--no-pretty', '--read', 'CONVENTIONS.md'])
  const codex = await entryOf('codex')
  const lemonadeArgs = [
    '-c', 'model_provider="lemonade"',
    '-c', 'model_providers.lemonade.name="Lemonade"',
    '-c', 'model_providers.lemonade.base_url="http://127.0.0.1:13305/v1"',
    '-c', 'model_providers.lemonade.env_key="LEMON_TREE_LOCAL_KEY"',
    '-c', 'model_providers.lemonade.wire_api="chat"',
  ]
  const mcpArgs = ['-c', 'mcp_servers.lemon-tree.url="http://127.0.0.1:9/mcp/job-1"']
  assert.deepEqual(buildHeadlessArgs(codex, vars, 'amd-lemonade-local'),
    ['exec', '--json', '--model', 'test-model', 'Edit the file.', ...lemonadeArgs, ...mcpArgs])
  assert.deepEqual(buildHeadlessArgs(codex, vars, 'cloud-api'),
    ['exec', '--json', '--model', 'test-model', 'Edit the file.', ...mcpArgs])
})

test('buildEnv deep-merges the two OPENCODE_CONFIG_CONTENT templates of the opencode entry', async () => {
  const content = JSON.parse(buildEnv(await entryOf('opencode'), vars, 'amd-lemonade-local').OPENCODE_CONFIG_CONTENT) as {
    model: string
    provider: { lemonade: { options: { baseURL: string }; models: Record<string, { name: string }> } }
    mcp: Record<string, unknown>
  }
  assert.equal(content.model, 'lemonade/test-model')
  assert.equal(content.provider.lemonade.options.baseURL, 'http://127.0.0.1:13305/v1')
  assert.deepEqual(content.provider.lemonade.models, { 'test-model': { name: 'test-model' } })
  assert.deepEqual(content.mcp, { 'lemon-tree': { type: 'remote', url: 'http://127.0.0.1:9/mcp/job-1' } })
})

test('buildEnv throws TemplateError when one key repeats and one of the two values is a plain string', async () => {
  const opencode = await entryOf('opencode')
  const plainMcp: HarnessManifestEntry = { ...opencode, mcp: { ...opencode.mcp, env: { OPENCODE_CONFIG_CONTENT: 'plain value' } } }
  assert.throws(() => buildEnv(plainMcp, vars, 'cloud-api'), TemplateError)
  const plainCloud: HarnessManifestEntry = { ...opencode, env: { ...opencode.env, cloud: { OPENCODE_CONFIG_CONTENT: 'plain value' } } }
  assert.throws(() => buildEnv(plainCloud, vars, 'cloud-api'), TemplateError)
})

test('renders the headless args and env of every manifest entry for both backends', async () => {
  const entries = parseHarnessManifest(JSON.parse(await readFile('../harnesses.json', 'utf8')) as unknown)
  assert.equal(entries.length, 6)
  for (const entry of entries) {
    for (const backend of ['cloud-api', 'amd-lemonade-local'] as const) {
      const args = buildHeadlessArgs(entry, vars, backend)
      assert.equal(args.join('\n').split(vars.prompt).length - 1, 1, `${entry.id} ${backend}: the prompt appears one time`)
      for (const arg of args) assert.deepEqual(placeholdersIn(arg), [], `${entry.id} ${backend}: unresolved argument ${arg}`)
      for (const [key, value] of Object.entries(buildEnv(entry, vars, backend))) {
        assert.equal(typeof value, 'string', `${entry.id} ${backend}: ${key} is not a string`)
        assert.deepEqual(placeholdersIn(value), [], `${entry.id} ${backend}: unresolved env ${key}`)
      }
    }
  }
})

async function entryOf(id: HarnessId): Promise<HarnessManifestEntry> {
  const manifest = parseHarnessManifest(JSON.parse(await readFile('../harnesses.json', 'utf8')) as unknown)
  const entry = manifest.find(item => item.id === id)
  assert.ok(entry, `harnesses.json has no ${id} entry`)
  return entry
}
