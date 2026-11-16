import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { test } from 'node:test'
import { CONTRACT_VERSION, OWN_KINDS, UPSTREAM_KINDS } from '../src/shared/boundary'
import type { EnvelopeKind } from '../src/shared/boundary'
import { decodeBody, decodeEnvelope, encodeEnvelope } from '../src/shared/boundary-schemas'
import type { BodyOf } from '../src/shared/boundary-schemas'

type Tree = Extract<BodyOf<'process-listing'>, { supported: true }>['trees'][number]
const process: Tree['processes'][number] = {
  pid: 10, ppid: 1, name: 'opencode', cmdline: 'opencode run', startTime: '2026-11-15T00:00:00Z', cpuSeconds: 1, cpuPercent: 2, memoryMb: 30,
  role: 'agent', roleSource: 'job', roleEvidence: 'job job-1',
}
const tree: Tree = {
  jobId: 'job-1', harness: 'opencode', backend: 'cloud-api', backendEvidence: 'env', userOrPeer: 'local', rootPid: 10,
  containmentMode: 'linux-cgroup', totalCpuPercent: 2, totalMemoryMb: 30, processes: [process], roleCounts: { agent: 1 },
}
const turn: NonNullable<BodyOf<'remote-job-payload'>['handoffContext']>['history'][number] = {
  jobId: 'job-1', turnIndex: 0, harnessId: 'opencode', modelId: 'm', userPrompt: 'p', assistantSummary: 's', filesTouched: [], durationMs: 5,
  toolCallCount: 0, toolCallFailures: 0, timestamp: 1,
}

// One valid body for each kind, and the path of one object in it that takes an unknown field.
const samples: { [K in EnvelopeKind]: { body: BodyOf<K>; objectPath: (string | number)[] } } = {
  'process-listing': { body: { supported: true, trees: [tree], accelerators: null, listedAt: 1 }, objectPath: ['trees', 0, 'processes', 0] },
  'kill-result': { body: { killedPids: [10], failedPids: [], errors: [] }, objectPath: [] },
  'accelerator-snapshot': { body: { devices: [{ id: 'gpu0', kind: 'gpu' }], status: [{ source: 'none', kind: 'any', available: false }], sampledAt: 1 }, objectPath: ['devices', 0] },
  'lemonade-status': { body: { reachable: true, url: 'http://127.0.0.1:13305', loadedModels: [], availableModels: ['m'] }, objectPath: [] },
  'role-catalog': { body: [{ role: 'agent', label: 'Agent', description: 'Root agent', definitions: ['opencode'] }], objectPath: [0] },
  'toolkit-selection': { body: { status: 'ok', target: { providerInstanceId: 'opencode', model: 'm', options: { variant: 'high' } }, canonical: 'opencode:m#variant=high', reasoning: 3 }, objectPath: ['target'] },
  'job-event': { body: { jobId: 'job-1', index: 0, ts: 1, kind: 'error', payload: { message: 'stopped', fatal: false } }, objectPath: ['payload'] },
  'remote-job-payload': {
    body: {
      jobId: 'job-1', threadId: 't', projectId: 'p', repoUrl: 'https://example.invalid/r.git', baseBranch: 'main', targetBranch: 'agent/job-1',
      harnessId: 'opencode', modelId: 'm', protocol: 'acp-stdio', backend: 'cloud-api', permissionPolicy: 'strict', prompt: 'p',
      handoffContext: { threadId: 't', projectId: 'p', worktreePath: '/w', projectMemory: { stack: 'bun' }, history: [turn] },
      ephemeralBootEnv: { TOKEN: 'synthetic' }, senderPeerId: 'peer-a',
    },
    objectPath: ['handoffContext', 'history', 0],
  },
  'remote-job-ack': { body: { accepted: false, jobId: 'job-1', peerId: 'peer-b', reason: 'busy' }, objectPath: [] },
  'secret-access-result': { body: { granted: false, reason: 'locked', approvalRequired: true }, objectPath: [] },
  'project-memory': { body: { stack: 'bun' }, objectPath: [] },
}
const capabilities = { present: ['agtop.trees' as const] }
const kinds = Object.keys(samples) as EnvelopeKind[]

function withUnknownField(kind: EnvelopeKind): unknown {
  const body = structuredClone(samples[kind].body) as unknown
  const target = samples[kind].objectPath.reduce<unknown>((value, key) => (value as Record<string | number, unknown>)[key], body)
  ;(target as Record<string, unknown>).addedLater = 1
  return body
}

for (const kind of kinds) {
  test(`${kind}: a valid envelope decodes to the same body`, () => {
    const decoded = decodeEnvelope(kind, structuredClone(encodeEnvelope(kind, samples[kind].body, ['agtop.trees'])), capabilities)
    deepStrictEqual(decoded, { ok: true, value: samples[kind].body, ignoredFields: [] })
  })

  test(`${kind}: a different major version is rejected before the body is read`, () => {
    const decoded = decodeEnvelope(kind, { ...encodeEnvelope(kind, samples[kind].body), v: { major: CONTRACT_VERSION.major + 1, minor: 0 }, body: 'not a body' }, capabilities)
    deepStrictEqual(decoded, { ok: false, issues: [{ code: 'major-mismatch', got: CONTRACT_VERSION.major + 1, want: CONTRACT_VERSION.major }] })
  })
}

// A string-keyed record takes each key, so project-memory has no unknown-field case.
for (const kind of UPSTREAM_KINDS) {
  test(`${kind}: an unknown upstream field is dropped and listed`, () => {
    const decoded = decodeBody(kind, withUnknownField(kind))
    ok(decoded.ok)
    deepStrictEqual(decoded.value, samples[kind].body)
    strictEqual(decoded.ignoredFields.length, 1)
    ok(decoded.ignoredFields[0]!.endsWith('addedLater'))
  })
}

for (const kind of OWN_KINDS.filter(kind => kind !== 'project-memory')) {
  test(`${kind}: an unknown field is an error, unless the writer has a higher minor version`, () => {
    const envelope = { ...encodeEnvelope(kind, samples[kind].body), body: withUnknownField(kind) }
    const same = decodeEnvelope(kind, envelope, capabilities)
    ok(!same.ok)
    strictEqual(same.issues.length, 1)
    deepStrictEqual({ code: same.issues[0]!.code, message: 'message' in same.issues[0]! ? same.issues[0].message : '' }, { code: 'schema', message: 'Unknown field' })
    const newer = decodeEnvelope(kind, { ...envelope, v: { major: CONTRACT_VERSION.major, minor: CONTRACT_VERSION.minor + 1 } }, capabilities)
    ok(newer.ok)
    deepStrictEqual(newer.value, samples[kind].body)
    strictEqual(newer.ignoredFields.length, 1)
  })
}

test('the reader rejects a wrong format, a wrong kind, a missing capability, and an invalid body', () => {
  const envelope = encodeEnvelope('kill-result', samples['kill-result'].body, ['agtop.kill'])
  const issueOf = (raw: unknown, kind: EnvelopeKind = 'kill-result') => {
    const decoded = decodeEnvelope(kind, raw, capabilities)
    return decoded.ok ? null : decoded.issues[0]
  }
  strictEqual(issueOf({ ...envelope, format: 'other' })?.code, 'schema')
  strictEqual(issueOf(null)?.code, 'schema')
  deepStrictEqual(issueOf({ ...envelope, needs: [] }, 'lemonade-status'), { code: 'schema', path: 'kind', message: 'Expected lemonade-status, got kill-result' })
  deepStrictEqual(issueOf(envelope), { code: 'missing-capability', capability: 'agtop.kill' })
  deepStrictEqual(issueOf({ ...envelope, needs: [], body: { killedPids: ['10'], failedPids: [], errors: [] } }), { code: 'schema', path: 'killedPids.0', message: 'Invalid input: expected number, received string' })
})

test('an upstream value outside the pinned string set is kept as raw text', () => {
  const decoded = decodeBody('process-listing', { supported: true, trees: [{ ...tree, harness: 'new-harness', processes: [{ ...process, role: 'new-role' }] }], accelerators: null, listedAt: 1 })
  ok(decoded.ok && decoded.value.supported)
  strictEqual(decoded.value.trees[0]!.harness as string, 'new-harness')
  strictEqual(decoded.value.trees[0]!.processes[0]!.role as string, 'new-role')
  strictEqual(decoded.value.trees[0]!.harnessId, undefined)
})
