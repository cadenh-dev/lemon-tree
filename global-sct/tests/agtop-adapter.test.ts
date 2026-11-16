import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAgtopAdapter, type AgtopAdapter } from '../src/main/process-bridge/agtop-adapter.ts'
import { probeAgtopCapabilities } from '../src/main/process-bridge/capabilities.ts'
import type { CapabilityId } from '../src/shared/boundary.ts'

const AGTOP_IDS: CapabilityId[] = [
  'agtop.trees', 'agtop.kill', 'agtop.spawn-contained', 'agtop.roles',
  'agtop.accelerators', 'agtop.lemonade-probe', 'agtop.worktree-detect', 'agtop.daemon',
]

// The stub has the same shape as the agtop module. A test removes or replaces one function to make it absent or bad.
function baseModule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    listAgentTrees: async () => [],
    killAgentTree: async () => ({ killedPids: [], failedPids: [], errors: [] }),
    spawnContainedAgent: async () => ({ jobId: 'job-1', pid: 4242, containmentMode: 'passive-ppid' }),
    roleCatalog: () => [],
    getAcceleratorSnapshot: () => undefined,
    probeLemonade: async () => ({ reachable: false, url: 'http://127.0.0.1:13305', loadedModels: [], availableModels: [] }),
    resolveGitWorktree: () => ({ repoRoot: '/tmp/project', branch: 'main', isWorktree: false, gitDir: '/tmp/project/.git', commonDir: '/tmp/project/.git' }),
    startDaemon: () => undefined,
    ...overrides,
  }
}

function adapterFor(module: Record<string, unknown>): Promise<AgtopAdapter> {
  return createAgtopAdapter({ load: async () => module })
}

test('the real agtop module provides all eight agtop capabilities', async () => {
  const { present, missing } = (await createAgtopAdapter()).capabilities()
  assert.deepEqual(missing, [])
  assert.equal(present.length, AGTOP_IDS.length)
  for (const capability of AGTOP_IDS) assert.ok(present.includes(capability), `${capability} is not present`)
})

test('the real agtop role catalog lists every role with its fields', async () => {
  const catalog = (await createAgtopAdapter()).roleCatalog()
  assert.ok(catalog.length > 0)
  for (const entry of catalog) {
    assert.equal(typeof entry.role, 'string')
    assert.equal(typeof entry.label, 'string')
    assert.equal(typeof entry.description, 'string')
    assert.ok(Array.isArray(entry.definitions))
  }
})

test('listTrees returns the live trees and a listing time', { skip: process.platform === 'linux' ? false : 'The process scan in this test runs on Linux only.' }, async () => {
  const listing = await (await createAgtopAdapter()).listTrees()
  if (!listing.supported) assert.fail(listing.reason)
  assert.ok(Array.isArray(listing.trees))
  assert.equal(typeof listing.listedAt, 'number')
})

test('a module without kill and accelerators marks those two missing and degrades each method', async () => {
  const stub = baseModule()
  delete stub.killAgentTree
  delete stub.getAcceleratorSnapshot
  const adapter = await adapterFor(stub)
  const { missing } = adapter.capabilities()
  assert.deepEqual(missing.map(entry => entry.capability).sort(), ['agtop.accelerators', 'agtop.kill'])
  assert.ok(missing.every(entry => entry.reason.length > 0))
  const result = await adapter.killTree('job-1')
  assert.deepEqual(result.killedPids, [])
  assert.equal(result.errors.length, 1)
  assert.equal(adapter.acceleratorSnapshot(), null)
})

test('a load function that rejects marks every capability missing and degrades each method', async () => {
  const adapter = await createAgtopAdapter({ load: () => Promise.reject(new Error('Cannot find module agtop')) })
  const capabilities = adapter.capabilities()
  assert.equal(capabilities.present.length, 0)
  assert.equal(capabilities.missing.length, AGTOP_IDS.length)
  assert.ok(capabilities.missing.every(entry => entry.reason.includes('Cannot find module agtop')))
  const listing = await adapter.listTrees()
  if (listing.supported) assert.fail('A failed import must not produce a supported listing.')
  assert.ok(listing.reason.includes('Cannot find module agtop'))
  assert.deepEqual(adapter.roleCatalog(), [])
  assert.equal(adapter.acceleratorSnapshot(), null)
  assert.equal(await adapter.probeLemonade(), null)
})

test('spawnContained rejects with containment-unavailable when the function is absent', async () => {
  const stub = baseModule()
  delete stub.spawnContainedAgent
  const adapter = await adapterFor(stub)
  await assert.rejects(adapter.spawnContained({ harness: 'opencode', command: 'true' }), (error: unknown) => {
    return error instanceof Error && 'code' in error && error.code === 'containment-unavailable'
  })
})

test('an unwrapped harness keeps harnessId unset and the result drops an unknown field', async () => {
  const tree = {
    jobId: 'job-7', harness: 'not-a-wrapped-harness', backend: 'cloud-api', backendEvidence: 'stub',
    userOrPeer: 'local', rootPid: 11, containmentMode: 'passive-ppid',
    totalCpuPercent: 0, totalMemoryMb: 0, processes: [], roleCounts: {}, extraField: 'dropped',
  }
  const listing = await (await adapterFor(baseModule({ listAgentTrees: async () => [tree] }))).listTrees()
  if (!listing.supported) assert.fail(listing.reason)
  assert.equal(listing.trees.length, 1)
  assert.equal(listing.trees[0].harnessId, undefined)
  assert.equal('extraField' in listing.trees[0], false)
})

test('a listAgentTrees value of the wrong shape gives an unsupported listing and no throw', async () => {
  const adapter = await adapterFor(baseModule({ listAgentTrees: async () => ({ trees: 'not-an-array' }) }))
  const listing = await adapter.listTrees()
  if (listing.supported) assert.fail('A malformed tree list must not be supported.')
  assert.ok(listing.reason.length > 0)
})

test('a killAgentTree that throws gives a failure result with the message', async () => {
  const adapter = await adapterFor(baseModule({
    killAgentTree: async () => {
      throw new Error('The process tree is gone.')
    },
  }))
  assert.deepEqual(await adapter.killTree('job-9'), { killedPids: [], failedPids: [], errors: ['The process tree is gone.'] })
})

test('an invalid role catalog makes the roles capability missing', async () => {
  const adapter = await adapterFor(baseModule({ roleCatalog: () => [{ role: 'agent', label: 'Agent' }] }))
  const { missing } = adapter.capabilities()
  assert.deepEqual(missing.map(entry => entry.capability), ['agtop.roles'])
  assert.deepEqual(adapter.roleCatalog(), [])
})

test('a value that is not a module marks every agtop capability missing', () => {
  const capabilities = probeAgtopCapabilities('not a module', { agtop: 'pinned-agtop', toolkit: 'pinned-toolkit' }, 7)
  assert.equal(capabilities.present.length, 0)
  assert.equal(capabilities.missing.length, AGTOP_IDS.length)
  assert.equal(capabilities.probedAt, 7)
  assert.deepEqual(capabilities.pins, { agtop: 'pinned-agtop', toolkit: 'pinned-toolkit' })
})
