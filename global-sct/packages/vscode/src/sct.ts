import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod/v4'
import { sctEnvironment, sctExecutable } from '../../env/src/executable'
import type { AgentOutcome } from '../../../src/shared/agent'
import type { SecretMetadata } from '../../../src/shared/secrets'

export type SctSecret = Pick<SecretMetadata, 'id' | 'name'>

const metadataOutcome = z.object({
  requestId: z.string(),
  status: z.enum(['completed', 'refused', 'expired', 'failed']),
  result: z.array(z.object({ id: z.string(), name: z.string(), projectId: z.string() })).optional(),
  error: z.string().optional()
})

export interface SctStatus {
  executable: string
  version: string
}

export async function readSctStatus(): Promise<SctStatus> {
  const executable = sctExecutable()
  // A global.sct release without --version opens the desktop window and does not exit, so the check stops after a time limit.
  const { stdout } = await promisify(execFile)(executable, ['--version'], { timeout: 10_000, env: sctEnvironment() })
  return { executable, version: stdout.trim() }
}

export function readSecretMetadata(cwd: string): Promise<SctSecret[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(sctExecutable(), ['agent', 'list_secrets', '--stdin'], {
      cwd, shell: false, windowsHide: true, env: sctEnvironment(), stdio: ['pipe', 'pipe', 'pipe']
    })
    let output = ''
    let errors = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { output += chunk })
    child.stderr.on('data', (chunk: string) => { errors += chunk })
    child.once('error', () => reject(new Error('Cannot run global.sct. Check the CLI installation and SCT_CLI.')))
    child.stdin.once('error', () => reject(new Error('Cannot send the metadata request to global.sct.')))
    child.once('close', (code) => {
      let outcome: ReturnType<typeof parseMetadataOutcome>
      try {
        outcome = parseMetadataOutcome(output)
      } catch {
        reject(new Error(`The global.sct CLI returned an invalid metadata response.${errors.trim() ? ` ${errors.trim()}` : ''}`))
        return
      }
      if (outcome.status !== 'completed') {
        reject(new Error(outcome.error || `The global.sct request ${outcome.status}.`))
        return
      }
      if (code !== 0 || !outcome.result) {
        reject(new Error('The global.sct metadata request did not complete.'))
        return
      }
      resolve(outcome.result.map(({ id, name }) => ({ id, name })))
    })
    child.stdin.end('{}')
  })
}

function parseMetadataOutcome(output: string) {
  const line = output.trim().split(/\r?\n/).filter(Boolean).at(-1)
  try {
    return metadataOutcome.parse(JSON.parse(line ?? '')) satisfies AgentOutcome
  } catch {
    throw new Error('The global.sct CLI returned an invalid metadata response.')
  }
}
