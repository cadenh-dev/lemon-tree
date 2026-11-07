// Lemon Tree typed IPC map (Wave 0). Handlers are wired in Wave 3 with handle() in src/main/index.ts and
// invokeChannel() in src/preload/index.ts. Results travel inside Reply<T>; use null, not undefined, for "none".
import type { Reply } from './api'
import type {
  AutoCommitResult, ControlPlaneJobRecord, DiffSummary, EditorId, HarnessId, HarnessManifestEntry, HarnessPreflightResult,
  HarnessRecommendation, JobEvent, JobStartRequest, JobSyncRequest, JobSyncResponse, KillResult, LemonadeEngineState,
  LemonadeEvalMetrics, MergeResult, MetricsFilter, PeerInfo, PermissionDecision, PermissionRequestView, ProcessListing,
  ProjectMemory, PromptIntent, RoleInfo, SecretAuditEntry, ThreadRecord, ThreadSyncRequest, ThreadSyncResponse,
  AcceleratorSnapshot, JobBackend,
} from './contracts'

type Channel<A extends unknown[], R> = { args: A; result: R }

export type InvokeChannels = {
  'harness:list': Channel<[], HarnessManifestEntry[]>
  'harness:preflight': Channel<[harnessId: HarnessId], HarnessPreflightResult>
  'harness:recommend': Channel<[prompt: string, backend: JobBackend], { intent: PromptIntent; recommendations: HarnessRecommendation[] }>
  'thread:list': Channel<[projectId: string | null], ThreadRecord[]>
  'job:start': Channel<[request: JobStartRequest], ControlPlaneJobRecord>
  'job:cancel': Channel<[jobId: string], void>
  'job:list': Channel<[threadId: string | null], ControlPlaneJobRecord[]>
  'job:get': Channel<[jobId: string], ControlPlaneJobRecord | null>
  'job:events': Channel<[request: JobSyncRequest], JobSyncResponse>
  'permission:respond': Channel<[decision: PermissionDecision], void>
  'worktree:diff': Channel<[jobId: string], DiffSummary>
  'worktree:commit': Channel<[jobId: string, message: string], AutoCommitResult>
  'worktree:open': Channel<[jobId: string, editor: EditorId], void>
  'worktree:merge': Channel<[jobId: string], MergeResult>
  'worktree:discard': Channel<[jobId: string], void>
  'process:trees': Channel<[], ProcessListing>
  'process:kill': Channel<[treeId: string, expectedStartTime: string | null], KillResult>
  'process:roles': Channel<[], RoleInfo[]>
  'process:accelerators': Channel<[], AcceleratorSnapshot | null>
  'lemonade:status': Channel<[], LemonadeEngineState>
  'lemonade:start': Channel<[], LemonadeEngineState>
  'lemonade:stop': Channel<[], LemonadeEngineState>
  'lemonade:metrics': Channel<[filter: MetricsFilter], LemonadeEvalMetrics[]>
  'memory:recall': Channel<[projectId: string], ProjectMemory>
  'vault:audit': Channel<[limit: number], SecretAuditEntry[]>
  'peers:list': Channel<[], PeerInfo[]>
  'job:sync': Channel<[request: JobSyncRequest], JobSyncResponse>
  'threads:sync': Channel<[request: ThreadSyncRequest], ThreadSyncResponse>
}

export type PushEvents = {
  'job:event': [event: JobEvent]
  'job:updated': [job: ControlPlaneJobRecord]
  'permission:request': [request: PermissionRequestView]
  'process:changed': [listing: ProcessListing]
  'lemonade:changed': [state: LemonadeEngineState]
  'peers:changed': [peers: PeerInfo[]]
}

export type InvokeReply<K extends keyof InvokeChannels> = Reply<InvokeChannels[K]['result']>
