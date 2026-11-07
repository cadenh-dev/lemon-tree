import { probeLemonade } from 'agtop'
import type { AgentProcessTree as AgTopTree, HarnessType, ProcessRole } from 'agtop'
import type { AgentProcessTree, HarnessId, LemonadeStatus } from '../shared/contracts'

type Assert<T extends true> = T
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type SixHarnessesExist = Assert<Equal<Extract<HarnessType, HarnessId>, HarnessId>>
type LocalTreeFitsUpstream = Assert<AgTopTree extends AgentProcessTree ? true : false>
type LocalStatusFitsProbe = Assert<Awaited<ReturnType<typeof probeLemonade>> extends LemonadeStatus ? true : false>
type AllRolesFit = Assert<ProcessRole extends AgentProcessTree['processes'][number]['role'] ? true : false>
export type AgTopContractChecks = [SixHarnessesExist, LocalTreeFitsUpstream, LocalStatusFitsProbe, AllRolesFit]
