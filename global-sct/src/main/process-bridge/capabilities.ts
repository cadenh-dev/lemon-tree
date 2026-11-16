import type { CapabilityId, CapabilitySet } from '../../shared/boundary'
import { decodeBody } from '../../shared/boundary-schemas'

type AgtopExport = { capability: CapabilityId; name: string }

// Each agtop capability is one exported function of the pinned module.
const AGTOP_EXPORTS = [
  { capability: 'agtop.trees', name: 'listAgentTrees' },
  { capability: 'agtop.kill', name: 'killAgentTree' },
  { capability: 'agtop.spawn-contained', name: 'spawnContainedAgent' },
  { capability: 'agtop.roles', name: 'roleCatalog' },
  { capability: 'agtop.accelerators', name: 'getAcceleratorSnapshot' },
  { capability: 'agtop.lemonade-probe', name: 'probeLemonade' },
  { capability: 'agtop.worktree-detect', name: 'resolveGitWorktree' },
  { capability: 'agtop.daemon', name: 'startDaemon' },
] as const satisfies readonly AgtopExport[]

/** Every agtop capability, in the probe order. */
export const AGTOP_CAPABILITIES: readonly CapabilityId[] = AGTOP_EXPORTS.map(entry => entry.capability)

/**
 * Discovers the agtop capabilities from the loaded module. Discovery uses the exported functions, never a version
 * string. The roles capability also needs a catalog that matches the schema, because an empty or malformed catalog
 * cannot label a process.
 */
export function probeAgtopCapabilities(module: unknown, pins: { agtop: string; toolkit: string }, now: number = Date.now()): CapabilitySet {
  const present: CapabilityId[] = []
  const missing: CapabilitySet['missing'] = []
  for (const { capability, name } of AGTOP_EXPORTS) {
    const reason = missingReason(module, capability, name)
    if (reason === null) present.push(capability)
    else missing.push({ capability, reason })
  }
  return { present, missing, probedAt: now, pins }
}

function missingReason(module: unknown, capability: CapabilityId, name: string): string | null {
  if (!isRecord(module)) return `The agtop module is not an object, so ${name} is absent.`
  const value = module[name]
  if (!isFunction(value)) return `agtop does not export ${name}.`
  return capability === 'agtop.roles' ? catalogReason(value) : null
}

function catalogReason(catalog: (...args: unknown[]) => unknown): string | null {
  try {
    const decoded = decodeBody('role-catalog', catalog())
    return decoded.ok ? null : 'roleCatalog returned data that does not match the role catalog schema.'
  } catch (error) {
    return `roleCatalog failed: ${String(error)}`
  }
}

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
