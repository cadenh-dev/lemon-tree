import { probeLemonade } from 'agtop'
import type { AgentProcessTree as AgTopTree, HarnessType, ProcessRole } from 'agtop'
import type { BodyOf } from '../shared/boundary-schemas'
import type { ToolkitSelection } from '../shared/boundary'
import type {
  AcceleratorSnapshot, AgentProcessTree, HarnessId, JobEvent, KillResult, LemonadeStatus, ProcessListing, ProjectMemory, RemoteJobAck,
  RemoteJobPayload, RoleInfo, SecretAccessResult,
} from '../shared/contracts'

type Assert<T extends true> = T
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type SixHarnessesExist = Assert<Equal<Extract<HarnessType, HarnessId>, HarnessId>>
type LocalTreeFitsUpstream = Assert<AgTopTree extends AgentProcessTree ? true : false>
type LocalStatusFitsProbe = Assert<Awaited<ReturnType<typeof probeLemonade>> extends LemonadeStatus ? true : false>
type AllRolesFit = Assert<ProcessRole extends AgentProcessTree['processes'][number]['role'] ? true : false>
export type AgTopContractChecks = [SixHarnessesExist, LocalTreeFitsUpstream, LocalStatusFitsProbe, AllRolesFit]

// Boundary schemas (src/shared/boundary-schemas.ts). Each schema and its contract type must accept the same values.
// A pin move that changes an agtop type, or a contract change without a schema change, fails typecheck:tsc here.
// The check is mutual assignability. Strict identity fails for an intersection type such as AgentProcessTree,
// which has the same members as the inferred object type.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type ProcessListingMatches = Assert<Same<BodyOf<'process-listing'>, ProcessListing>>
type KillResultMatches = Assert<Same<BodyOf<'kill-result'>, KillResult>>
type AcceleratorSnapshotMatches = Assert<Same<BodyOf<'accelerator-snapshot'>, AcceleratorSnapshot>>
type LemonadeStatusMatches = Assert<Same<BodyOf<'lemonade-status'>, LemonadeStatus>>
type RoleCatalogMatches = Assert<Same<BodyOf<'role-catalog'>, RoleInfo[]>>
type ToolkitSelectionMatches = Assert<Same<BodyOf<'toolkit-selection'>, ToolkitSelection>>
type JobEventMatches = Assert<Same<BodyOf<'job-event'>, JobEvent>>
type RemoteJobPayloadMatches = Assert<Same<BodyOf<'remote-job-payload'>, RemoteJobPayload>>
type RemoteJobAckMatches = Assert<Same<BodyOf<'remote-job-ack'>, RemoteJobAck>>
type SecretAccessResultMatches = Assert<Same<BodyOf<'secret-access-result'>, SecretAccessResult>>
type ProjectMemoryMatches = Assert<Same<BodyOf<'project-memory'>, ProjectMemory>>
export type BoundarySchemaChecks = [
  ProcessListingMatches, KillResultMatches, AcceleratorSnapshotMatches, LemonadeStatusMatches, RoleCatalogMatches, ToolkitSelectionMatches,
  JobEventMatches, RemoteJobPayloadMatches, RemoteJobAckMatches, SecretAccessResultMatches, ProjectMemoryMatches,
]
