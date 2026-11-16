// Lemon Tree boundary layer (Wave 0, lead-owned). Renderer-safe: types and constants only, no Node APIs.
// Every message that crosses IPC, the job event log, the mesh, or a subprocess pipe travels in one envelope.
// The run-time schemas and the reader are in boundary-schemas.ts.

/** Major: breaking. Minor: additive fields only. */
export const CONTRACT_VERSION = { major: 1, minor: 0 } as const

export const CAPABILITIES = [
  'agtop.trees', 'agtop.kill', 'agtop.spawn-contained', 'agtop.roles', 'agtop.accelerators',
  'agtop.lemonade-probe', 'agtop.worktree-detect', 'agtop.daemon',
  'toolkit.select-target', 'toolkit.verify-unit', 'toolkit.plan-schema', 'toolkit.fix-brief',
  'acp.v1', 'acp.fs', 'acp.terminal',
  'sct.envelope-v1', 'sct.direct-hyperswarm', 'sct.direct-webrtc', 'sct.mailbox', 'sct.share-gate',
] as const
/** The `x.<name>` form lets a project addition register a capability without a change to the union. */
export type CapabilityId = (typeof CAPABILITIES)[number] | `x.${string}`

/** Discovery uses facts about the materialized pins, never version numbers. */
export interface CapabilitySet {
  present: CapabilityId[]
  missing: { capability: CapabilityId; reason: string }[]
  probedAt: number
  pins: { agtop: string; toolkit: string }
}

/** Data that comes from a pinned upstream. Its unknown fields are dropped and listed, never rejected. */
export const UPSTREAM_KINDS = ['process-listing', 'kill-result', 'accelerator-snapshot', 'lemonade-status', 'role-catalog', 'toolkit-selection'] as const
/** Data that Lemon Tree writes. An unknown field is an error, unless the writer has a higher minor version. */
export const OWN_KINDS = ['job-event', 'remote-job-payload', 'remote-job-ack', 'secret-access-result', 'project-memory'] as const
export type EnvelopeKind = (typeof UPSTREAM_KINDS)[number] | (typeof OWN_KINDS)[number]

export interface Envelope<K extends EnvelopeKind, T> {
  /** Fixed marker. A reader rejects any other value before it reads the body. */
  format: 'lemon-tree'
  v: { major: number; minor: number }
  kind: K
  /** Capabilities the writer used to build the body. The reader needs all of them. */
  needs: CapabilityId[]
  body: T
}

export type BoundaryIssue =
  | { code: 'major-mismatch'; got: number; want: number }
  | { code: 'missing-capability'; capability: CapabilityId }
  | { code: 'schema'; path: string; message: string }

/** A failed decode never reaches the store, the renderer, or the vault. */
export type Decoded<T> = { ok: true; value: T; ignoredFields: string[] } | { ok: false; issues: BoundaryIssue[] }

/** The `--json` result of the toolkit's select_target.py. Only the fields that Lemon Tree reads. */
export type ToolkitSelection =
  | { status: 'ok'; target: { providerInstanceId: string; model: string; options: Record<string, string | number | boolean> }; canonical: string; reasoning: number }
  | { status: 'unavailable' | 'budget_exceeded'; reason: string }
