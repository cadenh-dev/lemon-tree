// Run-time schemas for every shape that crosses a process or repository edge (Wave 0, lead-owned).
// src/main/agtop-type-check.ts proves at compile time that each schema and its contract type agree.
import { z } from 'zod'
import type { SessionUpdate } from './acp-types'
import { CONTRACT_VERSION, OWN_KINDS } from './boundary'
import type { BoundaryIssue, CapabilityId, CapabilitySet, Decoded, Envelope, EnvelopeKind } from './boundary'
import { HARNESS_IDS } from './contracts'
import type {
  AcceleratorKind, Backend, ContainmentMode, HarnessType, PermissionOptionKind, PermissionPolicy, ProcessRole, RoleSource, ToolOperationKind,
} from './contracts'

// ---------------------------------------------------------------- Upstream data (agtop, toolkit)

// An upstream string set can grow at the next pin. The schema accepts each string at run time and keeps the
// pinned type at compile time. A consumer shows an unknown value as raw text and never fails on it.
const open = <T extends string>() => z.custom<T>(value => typeof value === 'string', { message: 'Expected a string' })
const acceleratorKind = open<AcceleratorKind>()

const listeningSocket = z.object({ address: z.string(), port: z.number() })
const socketConnection = z.object({ address: z.string(), port: z.number(), serverPid: z.number().optional(), serverHarness: open<HarnessType>().optional() })
const acceleratorUsage = z.object({
  deviceId: z.string(), kind: acceleratorKind, utilizationPercent: z.number().optional(), engine: z.string().optional(), memoryBytes: z.number().optional(),
})
const agentProcess = z.object({
  pid: z.number(), ppid: z.number(), name: z.string(), cmdline: z.string(), argv: z.array(z.string()).optional(),
  startTime: z.string(), cpuSeconds: z.number(), cpuPercent: z.number(), memoryMb: z.number(),
  cwd: z.string().optional(), pgid: z.number().optional(), envTags: z.record(z.string(), z.string()).optional(),
  cgroup: z.string().optional(), state: z.string().optional(),
  accelerators: z.array(acceleratorUsage).optional(),
  socketConnections: z.array(socketConnection).optional(),
  listeningSockets: z.array(listeningSocket).optional(),
  role: open<ProcessRole>(), roleSource: open<RoleSource>(), roleEvidence: z.string(),
})
const gitWorktreeInfo = z.object({ repoRoot: z.string(), branch: z.string(), isWorktree: z.boolean(), gitDir: z.string(), commonDir: z.string() })
export const agentProcessTreeSchema = z.object({
  jobId: z.string(), harness: open<HarnessType>(), backend: open<Backend>(), backendEvidence: z.string(),
  userOrPeer: z.string(), rootPid: z.number(), git: gitWorktreeInfo.optional(), containmentMode: open<ContainmentMode>(),
  totalCpuPercent: z.number(), totalMemoryMb: z.number(), processes: z.array(agentProcess),
  gpuPercent: z.number().optional(), npuPercent: z.number().optional(), gpuMemoryMb: z.number().optional(),
  roleCounts: z.partialRecord(open<ProcessRole>(), z.number()),
  harnessId: z.enum(HARNESS_IDS).optional(),
})
export const acceleratorSnapshotSchema = z.object({
  devices: z.array(z.object({
    id: z.string(), kind: acceleratorKind, name: z.string().optional(), vendor: z.string().optional(), utilizationPercent: z.number().optional(),
  })),
  status: z.array(z.object({
    source: open<'windows-pdh' | 'linux-drm-fdinfo' | 'nvml' | 'darwin-iokit' | 'none'>(), kind: open<AcceleratorKind | 'any'>(),
    available: z.boolean(), reason: z.string().optional(), message: z.string().optional(),
  })),
  sampledAt: z.number(),
})
export const processListingSchema = z.discriminatedUnion('supported', [
  z.object({ supported: z.literal(true), trees: z.array(agentProcessTreeSchema), accelerators: acceleratorSnapshotSchema.nullable(), listedAt: z.number() }),
  z.object({ supported: z.literal(false), reason: z.string() }),
])
export const killResultSchema = z.object({ killedPids: z.array(z.number()), failedPids: z.array(z.number()), errors: z.array(z.string()) })
export const lemonadeStatusSchema = z.object({
  reachable: z.boolean(), url: z.string(), loadedModels: z.array(z.string()), availableModels: z.array(z.string()), error: z.string().optional(),
})
export const roleInfoSchema = z.object({ role: open<ProcessRole>(), label: z.string(), description: z.string(), definitions: z.array(z.string()) })
export const roleCatalogSchema = z.array(roleInfoSchema)
export const toolkitSelectionSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    target: z.object({ providerInstanceId: z.string().min(1), model: z.string().min(1), options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])) }),
    canonical: z.string().min(1),
    reasoning: z.number(),
  }),
  z.object({ status: z.enum(['unavailable', 'budget_exceeded']), reason: z.string() }),
])

// ---------------------------------------------------------------- Lemon Tree data

const harnessId = z.enum(HARNESS_IDS)
const jobBackend = z.enum(['amd-lemonade-local', 'cloud-api'])
const protocol = z.enum(['acp-stdio', 'headless-json'])
const permissionPolicy = z.enum(['safe-sandbox', 'full-autonomous', 'strict']) satisfies z.ZodType<PermissionPolicy>
const optionKind = z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']) satisfies z.ZodType<PermissionOptionKind>
const operation = z.enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']) satisfies z.ZodType<ToolOperationKind>
const jobStatus = z.enum(['queued', 'running', 'paused-permission', 'completed', 'failed', 'cancelled', 'merged', 'discarded'])

const permissionRequestView = z.object({
  jobId: z.string(), requestId: z.string(), toolCallId: z.string().nullable(), title: z.string(), operation,
  paths: z.array(z.string()), commands: z.array(z.string()),
  options: z.array(z.object({ optionId: z.string(), kind: optionKind, name: z.string() })),
  policy: permissionPolicy, requestedAt: z.number(),
})
const permissionDecision = z.object({
  jobId: z.string(), requestId: z.string(), optionId: z.string(), kind: optionKind, decidedBy: z.enum(['user', 'policy']), decidedAt: z.number(),
})
const turnSummary = z.object({
  jobId: z.string(), turnIndex: z.number(), harnessId, modelId: z.string(), userPrompt: z.string(), assistantSummary: z.string(),
  filesTouched: z.array(z.string()), gitCommitHash: z.string().optional(), durationMs: z.number(), totalTokens: z.number().optional(),
  toolCallCount: z.number(), toolCallFailures: z.number(), timestamp: z.number(),
})
const diffSummary = z.object({
  baseBranch: z.string(), worktreeBranch: z.string(), commitHash: z.string().optional(), totalAdditions: z.number(), totalDeletions: z.number(),
  files: z.array(z.object({
    filePath: z.string(), additions: z.number(), deletions: z.number(), status: z.enum(['modified', 'added', 'deleted', 'renamed']), binary: z.boolean(),
  })),
})
const evalMetrics = z.object({
  jobId: z.string(), harnessId, modelId: z.string(), backend: jobBackend, wallClockMs: z.number(),
  promptTokens: z.number().nullable(), completionTokens: z.number().nullable(), toolCallsTotal: z.number(), toolCallsFailed: z.number(),
  gpuPercent: z.number().optional(), npuPercent: z.number().optional(), gpuMemoryMb: z.number().optional(),
})

const jobEventOf = <K extends string, P extends z.ZodType>(kind: K, payload: P) =>
  z.object({ jobId: z.string(), index: z.number().int().min(0), ts: z.number(), kind: z.literal(kind), payload })
// The ACP session update comes from the agent. The log keeps it as received; the ACP SDK validates it at the connection.
const sessionUpdate = z.custom<SessionUpdate>(value => typeof value === 'object' && value !== null && 'sessionUpdate' in value, { message: 'Expected an ACP session update' })
/** One line of events.ndjson. */
export const jobEventSchema = z.discriminatedUnion('kind', [
  jobEventOf('status', z.object({ status: jobStatus, detail: z.string().optional() })),
  jobEventOf('acp-update', z.object({ sessionId: z.string(), update: sessionUpdate })),
  jobEventOf('permission-request', permissionRequestView),
  jobEventOf('permission-decision', permissionDecision),
  jobEventOf('tool-call', z.object({ toolCallId: z.string(), title: z.string(), operation, status: z.enum(['pending', 'in_progress', 'completed', 'failed']) })),
  jobEventOf('turn-summary', turnSummary),
  jobEventOf('diff-summary', diffSummary),
  jobEventOf('metrics', evalMetrics),
  jobEventOf('log', z.object({ level: z.enum(['debug', 'info', 'warn', 'error']), source: z.enum(['harness-stdout', 'harness-stderr', 'control-plane']), message: z.string() })),
  jobEventOf('error', z.object({ message: z.string(), code: z.string().optional(), fatal: z.boolean() })),
])

export const projectMemorySchema = z.record(z.string(), z.string())
const handoffContext = z.object({
  goal: z.string(), completedFiles: z.array(z.string()), keyDecisions: z.array(z.string()), remainingWork: z.array(z.string()),
  text: z.string(), tokenEstimate: z.number(), compactor: z.enum(['lemonade', 'deterministic']),
})
const crossHarnessContext = z.object({
  threadId: z.string(), projectId: z.string(), worktreePath: z.string(), projectMemory: projectMemorySchema,
  history: z.array(turnSummary), handoff: handoffContext.optional(),
})
/** Travels only inside a sealed envelope. `ephemeralBootEnv` holds secrets: never persist it or log it. */
export const remoteJobPayloadSchema = z.object({
  jobId: z.string(), threadId: z.string(), projectId: z.string(), repoUrl: z.string(), baseBranch: z.string(), targetBranch: z.string(),
  harnessId, modelId: z.string(), protocol, backend: jobBackend, permissionPolicy, prompt: z.string(),
  handoffContext: crossHarnessContext.optional(), ephemeralBootEnv: z.record(z.string(), z.string()), senderPeerId: z.string(),
})
export const remoteJobAckSchema = z.discriminatedUnion('accepted', [
  z.object({ accepted: z.literal(true), jobId: z.string(), peerId: z.string(), transport: z.enum(['tailscale-direct', 'lan-mdns', 'relay-envelope']), acceptedAt: z.number() }),
  z.object({ accepted: z.literal(false), jobId: z.string(), peerId: z.string(), reason: z.string() }),
])
export const secretAccessResultSchema = z.discriminatedUnion('granted', [
  z.object({ granted: z.literal(true), value: z.string() }),
  z.object({ granted: z.literal(false), reason: z.string(), approvalRequired: z.boolean() }),
])

// ---------------------------------------------------------------- Envelope reader and writer

export const BODY_SCHEMAS = {
  'process-listing': processListingSchema,
  'kill-result': killResultSchema,
  'accelerator-snapshot': acceleratorSnapshotSchema,
  'lemonade-status': lemonadeStatusSchema,
  'role-catalog': roleCatalogSchema,
  'toolkit-selection': toolkitSelectionSchema,
  'job-event': jobEventSchema,
  'remote-job-payload': remoteJobPayloadSchema,
  'remote-job-ack': remoteJobAckSchema,
  'secret-access-result': secretAccessResultSchema,
  'project-memory': projectMemorySchema,
} as const satisfies Record<EnvelopeKind, z.ZodType>
export type BodyOf<K extends EnvelopeKind> = z.infer<(typeof BODY_SCHEMAS)[K]>

const envelopeHead = z.object({
  format: z.literal('lemon-tree'),
  v: z.object({ major: z.number().int().min(0), minor: z.number().int().min(0) }),
  kind: z.string(),
  needs: z.array(z.string()),
  body: z.unknown(),
})

export function encodeEnvelope<K extends EnvelopeKind>(kind: K, body: BodyOf<K>, needs: CapabilityId[] = []): Envelope<K, BodyOf<K>> {
  return { format: 'lemon-tree', v: { ...CONTRACT_VERSION }, kind, needs, body }
}

/**
 * Reads one envelope. The reader never guesses:
 * 1. `format`, then `v.major`. A different major is `major-mismatch`.
 * 2. Each entry in `needs` must be in the local capability set.
 * 3. The body must match the schema for `kind`. Unknown fields are dropped and listed in `ignoredFields`.
 *    For Lemon Tree's own data, an unknown field from a writer that is not newer is a schema issue.
 */
export function decodeEnvelope<K extends EnvelopeKind>(kind: K, raw: unknown, capabilities: Pick<CapabilitySet, 'present'>): Decoded<BodyOf<K>> {
  const head = envelopeHead.safeParse(raw)
  if (!head.success) return { ok: false, issues: schemaIssues(head.error) }
  if (head.data.v.major !== CONTRACT_VERSION.major) return { ok: false, issues: [{ code: 'major-mismatch', got: head.data.v.major, want: CONTRACT_VERSION.major }] }
  if (head.data.kind !== kind) return { ok: false, issues: [{ code: 'schema', path: 'kind', message: `Expected ${kind}, got ${head.data.kind}` }] }
  const present = new Set<string>(capabilities.present)
  const missing = head.data.needs.filter(need => !present.has(need))
  if (missing.length > 0) return { ok: false, issues: missing.map(capability => ({ code: 'missing-capability', capability: capability as CapabilityId })) }
  const body = decodeBody(kind, head.data.body)
  if (!body.ok || body.ignoredFields.length === 0 || head.data.v.minor > CONTRACT_VERSION.minor || !(OWN_KINDS as readonly string[]).includes(kind)) return body
  return { ok: false, issues: body.ignoredFields.map(path => ({ code: 'schema', path, message: 'Unknown field' })) }
}

/** Validates a value that has no envelope, for example a return value of agtop. Unknown fields are dropped and listed. */
export function decodeBody<K extends EnvelopeKind>(kind: K, value: unknown): Decoded<BodyOf<K>> {
  const parsed = BODY_SCHEMAS[kind].safeParse(value)
  return parsed.success ? { ok: true, value: parsed.data as BodyOf<K>, ignoredFields: droppedFields(value, parsed.data) } : { ok: false, issues: schemaIssues(parsed.error) }
}

function schemaIssues(error: z.ZodError): BoundaryIssue[] {
  return error.issues.map(issue => ({ code: 'schema', path: issue.path.join('.'), message: issue.message }))
}

/** Paths that are in the input and not in the parsed value. */
function droppedFields(input: unknown, output: unknown, path = ''): string[] {
  if (Array.isArray(input) && Array.isArray(output)) return input.flatMap((item, index) => droppedFields(item, output[index], `${path}[${index}]`))
  if (!isRecord(input) || !isRecord(output)) return []
  return Object.keys(input).flatMap(key => (key in output ? droppedFields(input[key], output[key], path === '' ? key : `${path}.${key}`) : [path === '' ? key : `${path}.${key}`]))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
