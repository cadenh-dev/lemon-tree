// Lemon Tree locked contracts (Wave 0). Renderer-safe: type imports only, no Node APIs.
// Changes to this file are escalated to the lead (see AGENTS.md).
// Timestamps are epoch milliseconds unless a field says otherwise.
import type {
  AcceleratorDevice, AcceleratorKind, AcceleratorSnapshot, AcceleratorStatus, AcceleratorUsage, AgentProcess,
  AgentProcessTree as AgtopProcessTree, Backend, ContainmentMode, GitWorktreeInfo, HarnessType, KillResult,
  ProcessRole, RawOsProcess, RoleSource, SpawnAgentOptions,
} from 'agtop'
import type { SessionUpdate } from './acp-types'
import type { Project } from './projects'

export type {
  AcceleratorDevice, AcceleratorKind, AcceleratorSnapshot, AcceleratorStatus, AcceleratorUsage, AgentProcess, Backend,
  ContainmentMode, GitWorktreeInfo, HarnessType, KillResult, ProcessRole, RawOsProcess, RoleSource, SpawnAgentOptions,
}

// ---------------------------------------------------------------- Harnesses

export const HARNESS_IDS = ['opencode', 'claude-code', 'aider', 'codex', 'goose', 'deepseek-harness'] as const
/** The six wrapped harnesses. Same strings as agtop's HarnessType (checked in src/main/agtop-type-check.ts). */
export type HarnessId = Extract<HarnessType, (typeof HARNESS_IDS)[number]>
export type ExecutionProtocol = 'acp-stdio' | 'headless-json'
export type InstructionFileName = 'AGENTS.md' | 'CLAUDE.md' | 'CONVENTIONS.md' | '.goosehints'
/** Where model inference runs for a job. Subset of agtop's Backend. */
export type JobBackend = Extract<Backend, 'amd-lemonade-local' | 'cloud-api'>

/** Harness Benefit Matrix row shown in the studio. */
export interface HarnessCapabilityProfile {
  autonomy: 'low' | 'medium' | 'high'
  tokenEfficiency: 'high' | 'medium' | 'heavy'
  diffStrategy: 'unified-diff' | 'search-replace' | 'full-file-ast' | 'whole-file'
  subagentSupport: boolean
  lspIntegration: boolean
  localModelFriendly: boolean
  bestFor: string[]
  tradeoffs: string
}

/**
 * Placeholders allowed in manifest templates. The runner substitutes them in memory only.
 * - `{prompt}` the user prompt (with any handoff block prepended)
 * - `{model}` the job's modelId
 * - `{baseUrl}` the Lemonade URL in the entry's lemonadeBaseUrlStyle (only valid in Lemonade-local fields)
 * - `{mcpUrl}` the vault/memory MCP server URL from VaultBroker.mcpAttachment (only valid in mcp fields)
 * - `{secret:NAME}` resolves through the vault at launch and is never written to disk
 */
export const TEMPLATE_PLACEHOLDERS = ['{prompt}', '{model}', '{baseUrl}', '{mcpUrl}'] as const
export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number]
export type JsonTemplate = string | number | boolean | null | JsonTemplate[] | { [key: string]: JsonTemplate }
/**
 * A template value. A plain string is substituted directly. `{ json }` is substituted inside every string
 * leaf and every object key, then JSON.stringify'd, for CLIs that take JSON in one argument or env var.
 */
export type TemplateValue = string | { json: JsonTemplate }
/**
 * Env vars for the child process. When the same key appears in more than one applied template
 * (env.cloud or env.lemonadeLocal, then mcp.env), `{ json }` objects are deep-merged in that order;
 * any other repeat is a manifest error.
 */
export type EnvTemplate = Record<string, TemplateValue>

/** One entry in global-sct/harnesses.json. Validated by src/shared/harness-manifest.ts. */
export interface HarnessManifestEntry {
  id: HarnessId
  displayName: string
  /** Executable checked by preflight. For adapter-mode ACP this is still the harness CLI itself. */
  binary: string
  installHint: string
  /** Version last verified by hand, or null when the CLI was not installed at verification time. */
  knownVersion: string | null
  versionArgs: string[]
  helpArgs: string[]
  /** Tokens preflight requires in `binary helpArgs` output. A missing token disables headless mode. */
  requiredHelpTokens: string[]
  defaultProtocol: ExecutionProtocol
  /** ACP launch. Env templates apply to ACP launches too; arg templates below are headless-only. */
  acp: { mode: 'native' | 'adapter' | 'none'; command: string | null; args: string[] }
  /**
   * Headless argv = headless.argsTemplate, then instruction.args, then lemonadeArgs (Lemonade-local only),
   * then mcp.argsTemplate. Options therefore come after any subcommand in argsTemplate.
   */
  headless: { argsTemplate: TemplateValue[]; output: 'json' | 'stream-json' | 'jsonl' | 'text' }
  env: { cloud: EnvTemplate; lemonadeLocal: EnvTemplate }
  /**
   * Extra headless args in Lemonade-local mode (for example per-run config overrides). ACP launches cannot
   * take them, so a Lemonade-local job for an entry with non-empty lemonadeArgs runs headless.
   */
  lemonadeArgs: TemplateValue[]
  /** What `{baseUrl}` resolves to: `<lemonade>/v1` for OpenAI-style clients, the bare root for clients that append paths themselves. */
  lemonadeBaseUrlStyle: 'openai-v1' | 'root' | 'unsupported'
  instruction: { fileName: InstructionFileName | null; args: TemplateValue[] }
  mcp: { method: 'cli-flag' | 'config-override' | 'env-config' | 'none'; argsTemplate: TemplateValue[]; env: EnvTemplate }
  /** Dotted field paths not confirmed from primary sources. The UI shows them as unverified. */
  unverified: string[]
  license: string | null
  benefits: HarnessCapabilityProfile
}

export interface HarnessPreflightResult {
  harnessId: HarnessId
  installed: boolean
  version: string | null
  missingHelpTokens: string[]
  acpAvailable: boolean
  /** Protocol the runner will use, or null when the harness cannot run. */
  protocol: ExecutionProtocol | null
  errors: string[]
  checkedAt: number
}

// ---------------------------------------------------------------- Processes (agtop)

/** agtop's process with role, roleSource and roleEvidence. No numeric confidence: roleSource is the signal. */
export type ClassifiedProcessNode = AgentProcess
export type AgentProcessTree = AgtopProcessTree & { harnessId?: HarnessId }
export interface RoleInfo { role: ProcessRole; label: string; description: string; definitions: string[] }
export type ProcessListing =
  | { supported: true; trees: AgentProcessTree[]; accelerators: AcceleratorSnapshot | null; listedAt: number }
  | { supported: false; reason: string }
/** Serializable view of agtop's ManagedAgent (which holds a Promise and a function). */
export interface SpawnedAgent { jobId: string; pid: number; containmentMode: ContainmentMode }

// ---------------------------------------------------------------- Prompt classification

export type PromptRole = 'implementation' | 'research' | 'review' | 'design' | 'test' | 'general'
export interface PromptIntent { role: PromptRole; depth: 1 | 2 | 3 | 4 | 5; evidence: string[] }
export interface HarnessRecommendation {
  harnessId: HarnessId
  modelId?: string
  /** Higher is better. Comparable only within one recommendation list. */
  score: number
  reasons: string[]
  source: 'toolkit-select-target' | 'manifest-heuristic'
}

// ---------------------------------------------------------------- Worktrees and diffs

export type WorktreeMode = 'isolated' | 'in-place'
export type EditorId = 'code' | 'cursor' | 'zed'
/** Isolated: `git worktree add -b agent/<jobId> ~/.global-sct/worktrees/<jobId> <baseBranch>`. */
export interface WorktreeRequest { jobId: string; repoRoot: string; baseBranch: string; mode: WorktreeMode }
/** Control-plane lifecycle record. Distinct from agtop's GitWorktreeInfo, which is detection only. */
export interface GitWorktreeMetadata {
  repoRoot: string
  worktreePath: string
  branch: string
  baseBranch: string
  isIsolatedWorktree: boolean
}
export interface DiffFileStat {
  filePath: string
  additions: number
  deletions: number
  status: 'modified' | 'added' | 'deleted' | 'renamed'
  /** Binary files report 0 additions and 0 deletions. */
  binary: boolean
}
export interface DiffSummary {
  baseBranch: string
  worktreeBranch: string
  commitHash?: string
  totalAdditions: number
  totalDeletions: number
  files: DiffFileStat[]
}
/** commitHash is null when there was nothing to commit. */
export interface AutoCommitResult { commitHash: string | null }
export type MergeResult = { merged: true; mergeCommit: string } | { merged: false; conflicts: string[]; reason: string }

// ---------------------------------------------------------------- Permissions (ACP v1)

export type PermissionPolicy = 'safe-sandbox' | 'full-autonomous' | 'strict'
export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
/** ACP v1 ToolKind values. */
export type ToolOperationKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other'
export interface PermissionOptionView { optionId: string; kind: PermissionOptionKind; name: string }
export interface PermissionRequestView {
  jobId: string
  /** Control-plane id for this pending request. */
  requestId: string
  toolCallId: string | null
  title: string
  operation: ToolOperationKind
  paths: string[]
  commands: string[]
  options: PermissionOptionView[]
  policy: PermissionPolicy
  requestedAt: number
}
export interface PermissionDecision {
  jobId: string
  requestId: string
  optionId: string
  kind: PermissionOptionKind
  decidedBy: 'user' | 'policy'
  decidedAt: number
}

// ---------------------------------------------------------------- Threads and jobs

export type JobStatus = 'queued' | 'running' | 'paused-permission' | 'completed' | 'failed' | 'cancelled' | 'merged' | 'discarded'
export type TargetPeer = 'local' | (string & {})
export type ProjectRef = Pick<Project, 'id' | 'name' | 'directory'>

export interface ThreadRecord {
  threadId: string
  /** global.sct Project.id. */
  projectId: string
  title: string
  createdAt: number
  updatedAt: number
  jobIds: string[]
}

export interface JobStartRequest {
  /** Omit to start a new thread. */
  threadId?: string
  projectId: string
  title: string
  prompt: string
  harnessId: HarnessId
  modelId: string
  /** Defaults to the manifest's defaultProtocol, downgraded by preflight when needed. */
  protocol?: ExecutionProtocol
  backend: JobBackend
  /** Defaults to LEMONADE_DEFAULTS.baseUrl when backend is amd-lemonade-local. */
  lemonadeUrl?: string
  permissionPolicy: PermissionPolicy
  worktreeMode: WorktreeMode
  /** Defaults to the project's current branch. */
  baseBranch?: string
  targetPeerId: TargetPeer
}

/** Control-plane job. Named to avoid clashing with agtop's JobRecord (its on-disk containment record). */
export interface ControlPlaneJobRecord {
  jobId: string
  threadId: string
  projectId: string
  title: string
  targetPeerId: TargetPeer
  harnessId: HarnessId
  modelId: string
  protocol: ExecutionProtocol
  backend: JobBackend
  lemonadeUrl: string | null
  permissionPolicy: PermissionPolicy
  worktree: GitWorktreeMetadata
  /** Root PID from agtop spawnContainedAgent. agtop's jobId equals this jobId. */
  rootPid: number | null
  status: JobStatus
  error: string | null
  diffSummary: DiffSummary | null
  evalMetrics: LemonadeEvalMetrics | null
  lastEventIndex: number
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------- Context handoff

export interface TurnSummary {
  jobId: string
  turnIndex: number
  harnessId: HarnessId
  modelId: string
  userPrompt: string
  assistantSummary: string
  filesTouched: string[]
  gitCommitHash?: string
  durationMs: number
  totalTokens?: number
  toolCallCount: number
  toolCallFailures: number
  timestamp: number
}
/** The ~500-token `<handoff_context>` block prepended when switching harnesses. */
export interface HandoffContext {
  goal: string
  completedFiles: string[]
  keyDecisions: string[]
  remainingWork: string[]
  /** Rendered `<handoff_context>...</handoff_context>` text. */
  text: string
  tokenEstimate: number
  compactor: 'lemonade' | 'deterministic'
}
export interface CrossHarnessContext {
  threadId: string
  projectId: string
  worktreePath: string
  projectMemory: ProjectMemory
  history: TurnSummary[]
  handoff?: HandoffContext
}

// ---------------------------------------------------------------- Lemonade

export const LEMONADE_DEFAULTS = {
  baseUrl: 'http://127.0.0.1:13305',
  openAiPath: '/v1',
  healthPath: '/v1/health',
  livePath: '/live',
  modelsPath: '/v1/models',
  mcpPath: '/mcp',
} as const
/** Superset of agtop probeLemonade()'s result (checked in src/main/agtop-type-check.ts). */
export interface LemonadeStatus { reachable: boolean; url: string; loadedModels: string[]; availableModels: string[]; error?: string }
export interface LemonadeEngineState {
  status: LemonadeStatus
  /** True when Lemon Tree started the server through agtop, so it may stop it. */
  startedByLemonTree: boolean
  managedPid: number | null
  checkedAt: number
}
export interface LemonadeEvalMetrics {
  jobId: string
  harnessId: HarnessId
  modelId: string
  backend: JobBackend
  wallClockMs: number
  /** null when the harness does not report token usage. */
  promptTokens: number | null
  completionTokens: number | null
  toolCallsTotal: number
  toolCallsFailed: number
  /** Peak values from agtop tree samples during the job, when available. */
  gpuPercent?: number
  npuPercent?: number
  gpuMemoryMb?: number
}
export interface MetricsFilter { jobId?: string; harnessId?: HarnessId; backend?: JobBackend }

// ---------------------------------------------------------------- Job event log

type JobEventOf<K extends string, P> = { jobId: string; index: number; ts: number; kind: K; payload: P }
/** One line of the append-only ~/.global-sct/jobs/<jobId>/events.ndjson. `index` starts at 0 and increases by 1. */
export type JobEvent =
  | JobEventOf<'status', { status: JobStatus; detail?: string }>
  | JobEventOf<'acp-update', { sessionId: string; update: SessionUpdate }>
  | JobEventOf<'permission-request', PermissionRequestView>
  | JobEventOf<'permission-decision', PermissionDecision>
  | JobEventOf<'tool-call', { toolCallId: string; title: string; operation: ToolOperationKind; status: 'pending' | 'in_progress' | 'completed' | 'failed' }>
  | JobEventOf<'turn-summary', TurnSummary>
  | JobEventOf<'diff-summary', DiffSummary>
  | JobEventOf<'metrics', LemonadeEvalMetrics>
  | JobEventOf<'log', { level: 'debug' | 'info' | 'warn' | 'error'; source: 'harness-stdout' | 'harness-stderr' | 'control-plane'; message: string }>
  | JobEventOf<'error', { message: string; code?: string; fatal: boolean }>
export type JobEventKind = JobEvent['kind']
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
/** What producers hand to JobStore.appendEvent; the store assigns `index`. */
export type JobEventInput = DistributiveOmit<JobEvent, 'index'>

export interface JobSyncRequest { jobId: string; lastSeenEventIndex: number }
/** Events with index > lastSeenEventIndex, in order. Use lastSeenEventIndex -1 for all. */
export interface JobSyncResponse { jobId: string; events: JobEvent[]; latestEventIndex: number; job: ControlPlaneJobRecord | null }
export interface ThreadSyncRequest { sinceTimestamp: number }
export interface ThreadSyncResponse { threads: ThreadRecord[]; jobs: ControlPlaneJobRecord[]; serverTime: number }

// ---------------------------------------------------------------- Remote execution

/** relay-envelope = the existing SpacetimeDB relay plus sealMessage. */
export type TransportTier = 'tailscale-direct' | 'lan-mdns' | 'relay-envelope'
export interface PeerInfo {
  peerId: string
  displayName: string
  online: boolean
  lastSeen: number | null
  transports: TransportTier[]
  lemonade: LemonadeStatus | null
}
/**
 * Travels only inside a global.sct sealed envelope (sealMessage gives encryption and sender authentication),
 * so it carries no signature of its own. `ephemeralBootEnv` holds secrets: never persist it, log it, or
 * write it into events.ndjson or sqlite, on either peer.
 */
export interface RemoteJobPayload {
  jobId: string
  threadId: string
  projectId: string
  repoUrl: string
  baseBranch: string
  targetBranch: string
  harnessId: HarnessId
  modelId: string
  protocol: ExecutionProtocol
  backend: JobBackend
  permissionPolicy: PermissionPolicy
  prompt: string
  handoffContext?: CrossHarnessContext
  ephemeralBootEnv: Record<string, string>
  senderPeerId: string
}
export type RemoteJobAck =
  | { accepted: true; jobId: string; peerId: string; transport: TransportTier; acceptedAt: number }
  | { accepted: false; jobId: string; peerId: string; reason: string }

// ---------------------------------------------------------------- Vault and memory

export type ProjectMemory = Record<string, string>
export interface BootEnvRequest { jobId: string; harnessId: HarnessId; backend: JobBackend; modelId: string; lemonadeUrl: string | null }
export interface SecretAccessRequest { secretName: string; callerPid: number; jobId: string | null }
export type SecretAccessResult = { granted: true; value: string } | { granted: false; reason: string; approvalRequired: boolean }
export interface SecretAuditEntry {
  ts: number
  secretName: string
  callerPid: number
  jobId: string | null
  harnessId: HarnessId | null
  outcome: 'granted' | 'denied' | 'approval-required'
  reason: string | null
}
/** How a harness reaches the local vault/memory MCP server. Streamable HTTP on 127.0.0.1; the URL carries a per-job path. */
export interface McpAttachment { transport: 'streamable-http'; url: string }

// ---------------------------------------------------------------- Service interfaces (implemented in src/main)

/** Wave 1A. Wraps the pinned agtop clone and the toolkit's select_target.py. */
export interface ProcessBridge {
  listTrees(): Promise<ProcessListing>
  killTree(treeId: string, expectedStartTime?: string): Promise<KillResult>
  spawnContained(options: SpawnAgentOptions): Promise<SpawnedAgent>
  roleCatalog(): RoleInfo[]
  acceleratorSnapshot(): AcceleratorSnapshot | null
  classifyPrompt(prompt: string): PromptIntent
  recommendHarness(intent: PromptIntent, backend: JobBackend): Promise<HarnessRecommendation[]>
}

/** Wave 1B. */
export interface WorktreeManager {
  create(request: WorktreeRequest): Promise<GitWorktreeMetadata>
  autoCommit(worktree: GitWorktreeMetadata, message: string): Promise<AutoCommitResult>
  diffSummary(worktree: GitWorktreeMetadata): Promise<DiffSummary>
  merge(worktree: GitWorktreeMetadata): Promise<MergeResult>
  discard(worktree: GitWorktreeMetadata): Promise<void>
  openInEditor(worktree: GitWorktreeMetadata, editor: EditorId): Promise<void>
}

/** Wave 1C. */
export interface VaultBroker {
  buildEphemeralBootEnv(request: BootEnvRequest): Promise<Record<string, string>>
  getScopedSecret(request: SecretAccessRequest): Promise<SecretAccessResult>
  rememberProjectFact(projectId: string, key: string, value: string): Promise<void>
  recallProjectMemory(projectId: string): Promise<ProjectMemory>
  auditLog(limit: number): Promise<SecretAuditEntry[]>
  mcpAttachment(jobId: string): Promise<McpAttachment>
}

/** Wave 1D. */
export interface LemonadeService {
  probe(baseUrl?: string): Promise<LemonadeStatus>
  state(): Promise<LemonadeEngineState>
  start(): Promise<LemonadeEngineState>
  stop(): Promise<LemonadeEngineState>
  recordMetrics(metrics: LemonadeEvalMetrics): void
  metrics(filter: MetricsFilter): LemonadeEvalMetrics[]
}

/** Wave 2A. Emits progress through JobStore.appendEvent. */
export interface HarnessRunner {
  manifest(): HarnessManifestEntry[]
  preflight(harnessId: HarnessId): Promise<HarnessPreflightResult>
  start(job: ControlPlaneJobRecord, prompt: string, context: CrossHarnessContext | null): Promise<void>
  cancel(jobId: string): Promise<void>
  respondToPermission(decision: PermissionDecision): Promise<void>
}

/** Wave 2A. */
export interface ContextBridge {
  /** Writes the harness's instruction file into the worktree and returns its absolute path. */
  writeInstructionFile(worktreePath: string, fileName: InstructionFileName, rules: string): Promise<string>
  buildCrossHarnessContext(threadId: string): Promise<CrossHarnessContext>
  compactHandoff(context: CrossHarnessContext): Promise<HandoffContext>
  renderPrompt(prompt: string, handoff: HandoffContext | null): string
}

/** Wave 2B. */
export interface RemoteDispatcher {
  peers(): Promise<PeerInfo[]>
  dispatch(peerId: string, payload: RemoteJobPayload): Promise<RemoteJobAck>
  syncJob(request: JobSyncRequest): Promise<JobSyncResponse>
  syncThreads(request: ThreadSyncRequest): Promise<ThreadSyncResponse>
}

/** Wave 2B. threads.sqlite index plus events.ndjson files. */
export interface JobStore {
  upsertThread(thread: ThreadRecord): Promise<void>
  listThreads(projectId?: string): Promise<ThreadRecord[]>
  upsertJob(job: ControlPlaneJobRecord): Promise<void>
  getJob(jobId: string): Promise<ControlPlaneJobRecord | null>
  listJobs(threadId?: string): Promise<ControlPlaneJobRecord[]>
  appendEvent(event: JobEventInput): Promise<JobEvent>
  events(request: JobSyncRequest): Promise<JobSyncResponse>
  threadsSince(request: ThreadSyncRequest): Promise<ThreadSyncResponse>
}
