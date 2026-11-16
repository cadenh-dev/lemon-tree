import type { SpawnAgentOptions } from 'agtop'
import type { BoundaryIssue, CapabilityId, CapabilitySet } from '../../shared/boundary'
import { decodeBody } from '../../shared/boundary-schemas'
import { HARNESS_IDS } from '../../shared/contracts'
import type {
  AcceleratorSnapshot, ContainmentMode, KillResult, LemonadeStatus, ProcessListing, RoleInfo, SpawnedAgent,
} from '../../shared/contracts'
import { AGTOP_CAPABILITIES, probeAgtopCapabilities } from './capabilities'

type Pins = { agtop: string; toolkit: string }
type AgtopFunction = (...args: unknown[]) => unknown

/** The pinned commits that this build embeds. They match pins.json at the repository root. */
const PINS: Pins = { agtop: 'd516dcb4c0dc888ce07622cb60eb4619f707e8bd', toolkit: '6190c313ed3a01d8d3e55cf92622d2e9420729a8' }

const harnessIds: ReadonlySet<string> = new Set<string>(HARNESS_IDS)
const containmentModes: ReadonlySet<string> = new Set<ContainmentMode>(['linux-cgroup', 'linux-env-pgid', 'darwin-env-pgid', 'win32-job-object', 'passive-ppid'])

export interface AgtopAdapterOptions {
  /** Dependency injection for a test. The default loads the installed agtop package. */
  load?: () => Promise<unknown>
  pins?: Pins
}

/** Wave 1A adapter over the pinned agtop clone. Only spawnContained rejects when a capability is absent. */
export interface AgtopAdapter {
  capabilities(): CapabilitySet
  listTrees(): Promise<ProcessListing>
  killTree(treeId: string, expectedStartTime?: string): Promise<KillResult>
  spawnContained(options: SpawnAgentOptions): Promise<SpawnedAgent>
  roleCatalog(): RoleInfo[]
  acceleratorSnapshot(): AcceleratorSnapshot | null
  probeLemonade(baseUrl?: string): Promise<LemonadeStatus | null>
}

/**
 * Loads agtop, keeps the capabilities that are present, and returns an adapter for each one. A missing module or a
 * missing function degrades the one method that uses it. No method throws because agtop is absent.
 */
export async function createAgtopAdapter(options: AgtopAdapterOptions = {}): Promise<AgtopAdapter> {
  const pins = options.pins ?? PINS
  const { module: agtopModule, error: loadError } = await loadAgtopModule(options.load ?? loadAgtop)
  const capabilitySet = loadError === null ? probeAgtopCapabilities(agtopModule, pins) : unavailableCapabilities(loadError, pins)
  const absent = (capability: CapabilityId) => capabilitySet.missing.find(entry => entry.capability === capability)?.reason ?? null
  const readAccelerators = () => acceleratorSnapshot(agtopModule, absent('agtop.accelerators'))
  return {
    capabilities: () => capabilitySet,
    listTrees: () => listTrees(agtopModule, absent('agtop.trees'), readAccelerators),
    killTree: (treeId, expectedStartTime) => killTree(agtopModule, absent('agtop.kill'), treeId, expectedStartTime),
    spawnContained: spawnOptions => spawnContained(agtopModule, absent('agtop.spawn-contained'), spawnOptions),
    roleCatalog: () => roleCatalog(agtopModule, absent('agtop.roles')),
    acceleratorSnapshot: readAccelerators,
    probeLemonade: baseUrl => probeLemonade(agtopModule, absent('agtop.lemonade-probe'), baseUrl),
  }
}

async function loadAgtop(): Promise<unknown> {
  return import('agtop')
}

interface LoadedModule { module: unknown; error: string | null }

async function loadAgtopModule(load: () => Promise<unknown>): Promise<LoadedModule> {
  try {
    return { module: await load(), error: null }
  } catch (error) {
    return { module: null, error: `The agtop module did not load: ${messageOf(error)}` }
  }
}

function unavailableCapabilities(reason: string, pins: Pins): CapabilitySet {
  return { present: [], missing: AGTOP_CAPABILITIES.map(capability => ({ capability, reason })), probedAt: Date.now(), pins }
}

async function listTrees(module: unknown, absentReason: string | null, accelerators: () => AcceleratorSnapshot | null): Promise<ProcessListing> {
  if (absentReason !== null) return { supported: false, reason: absentReason }
  try {
    const trees = withHarnessIds(await agtopFunction(module, 'listAgentTrees')())
    const decoded = decodeBody('process-listing', { supported: true, trees, accelerators: accelerators(), listedAt: Date.now() })
    return decoded.ok ? decoded.value : { supported: false, reason: schemaFailure('process listing', decoded.issues) }
  } catch (error) {
    return { supported: false, reason: messageOf(error) }
  }
}

async function killTree(module: unknown, absentReason: string | null, treeId: string, expectedStartTime?: string): Promise<KillResult> {
  if (absentReason !== null) return killFailure(absentReason)
  try {
    const killAgentTree = agtopFunction(module, 'killAgentTree')
    const raw = await (expectedStartTime === undefined ? killAgentTree(treeId) : killAgentTree(treeId, { expectedStartTime }))
    const decoded = decodeBody('kill-result', raw)
    return decoded.ok ? decoded.value : killFailure(schemaFailure('kill result', decoded.issues))
  } catch (error) {
    return killFailure(messageOf(error))
  }
}

async function spawnContained(module: unknown, absentReason: string | null, options: SpawnAgentOptions): Promise<SpawnedAgent> {
  if (absentReason !== null) throw containmentUnavailable(absentReason)
  return spawnedAgent(await agtopFunction(module, 'spawnContainedAgent')(options))
}

function roleCatalog(module: unknown, absentReason: string | null): RoleInfo[] {
  if (absentReason !== null) return []
  try {
    const decoded = decodeBody('role-catalog', agtopFunction(module, 'roleCatalog')())
    return decoded.ok ? decoded.value : []
  } catch {
    return []
  }
}

function acceleratorSnapshot(module: unknown, absentReason: string | null): AcceleratorSnapshot | null {
  if (absentReason !== null) return null
  try {
    const raw = agtopFunction(module, 'getAcceleratorSnapshot')()
    if (raw === undefined) return null
    const decoded = decodeBody('accelerator-snapshot', raw)
    return decoded.ok ? decoded.value : null
  } catch {
    return null
  }
}

async function probeLemonade(module: unknown, absentReason: string | null, baseUrl?: string): Promise<LemonadeStatus | null> {
  if (absentReason !== null) return null
  try {
    const probe = agtopFunction(module, 'probeLemonade')
    const decoded = decodeBody('lemonade-status', await (baseUrl === undefined ? probe() : probe(baseUrl)))
    return decoded.ok ? decoded.value : null
  } catch {
    return null
  }
}

function agtopFunction(module: unknown, name: string): AgtopFunction {
  const value = isRecord(module) ? module[name] : undefined
  if (!isFunction(value)) throw new Error(`agtop does not export ${name}.`)
  return value
}

// The listing schema keeps harnessId only for the six wrapped harnesses. Other harnesses stay raw text.
function withHarnessIds(trees: unknown): unknown {
  if (!Array.isArray(trees)) return trees
  return trees.map(tree => (isRecord(tree) && typeof tree.harness === 'string' && harnessIds.has(tree.harness) ? { ...tree, harnessId: tree.harness } : tree))
}

// agtop returns a live record with a promise and a function. Lemon Tree keeps only the serializable fields.
function spawnedAgent(agent: unknown): SpawnedAgent {
  if (!isRecord(agent)) throw new Error('agtop did not return an agent record.')
  const { jobId, pid, containmentMode } = agent
  if (typeof jobId !== 'string' || typeof pid !== 'number' || !isContainmentMode(containmentMode)) {
    throw new Error('agtop did not return an agent record with jobId, pid, and a known containmentMode.')
  }
  return { jobId, pid, containmentMode }
}

function isContainmentMode(value: unknown): value is ContainmentMode {
  return typeof value === 'string' && containmentModes.has(value)
}

function killFailure(reason: string): KillResult {
  return { killedPids: [], failedPids: [], errors: [reason] }
}

function containmentUnavailable(reason: string): Error {
  return Object.assign(new Error(reason), { code: 'containment-unavailable' })
}

function schemaFailure(label: string, issues: BoundaryIssue[]): string {
  const detail = issues.map(issue => (issue.code === 'schema' ? `${issue.path}: ${issue.message}` : issue.code)).join('; ')
  return `agtop returned a ${label} that does not match the schema: ${detail}`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isFunction(value: unknown): value is AgtopFunction {
  return typeof value === 'function'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
