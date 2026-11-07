import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { z } from 'zod/v4'
import { agentTools } from '../shared/agent'
import type { AgentCaller, AgentInput, AgentOperation, AgentOutcome, AgentRequestView, AgentResult } from '../shared/agent'
import type { ProjectStore } from './projects'
import { isProjectName } from './projects'
import { resolveProject } from './runtime'
import { demoOutcome, startFixedDemo } from './launch'
import type { Vault } from './vault'
import { requireExternalVault } from './vault'
import type { Sharing } from './sharing'
import type { RelayState } from '../shared/relay'
import type { Project } from '../shared/projects'
import type { ShareSummary } from '../shared/share'

interface AgentServices {
  review: () => Promise<void>
  changed: () => void
  sharing: () => Promise<Sharing>
  shareFile: (path: string) => Promise<void>
  // A secret share waits for the app passphrase dialog. The closure stays in the main process.
  approveShare: <T>(summary: ShareSummary, execute: () => Promise<T>) => Promise<T>
  relayState: () => Promise<RelayState>
  // Writes a task request for the desktop app to send. Returns the task ID.
  requestRemoteDemo: (grantId: string) => Promise<string>
  // Resolves to null when the caller fails the signature check of a listed agent.
  caller: Promise<AgentCaller | null>
  executable: string
  demo: string
}

interface PendingRequest {
  view: AgentRequestView
  submission: AgentInput
  stdinValue?: string
  pairingToken?: string
  shareSummary?: ShareSummary
  controller: AbortController
  timer: NodeJS.Timeout
  finish: (outcome: AgentOutcome) => void
}

export class AgentAccess {
  private readonly requests = new Map<string, PendingRequest>()
  private closed = false
  private last: AgentRequestView | undefined

  constructor(private readonly projects: ProjectStore, private readonly vault: Vault, private readonly services: AgentServices) {}

  async submit(input: unknown, signal?: AbortSignal): Promise<AgentOutcome> {
    const id = randomUUID()
    const caller = await this.services.caller
    if (!caller) return { requestId: id, status: 'failed', error: 'The calling program failed its signature check. global.sct rejected the request.' }
    try {
      if (this.closed || signal?.aborted) throw new Error('The caller disconnected.')
      const { submission, stdinValue } = requireSubmission(input)
      const expiresAt = requireDeadline(submission.input.expiresAt)
      const prepared = await this.prepare(submission, stdinValue)
      if (this.closed || signal?.aborted || Date.now() >= expiresAt) throw new Error('The request expired.')
      return await new Promise<AgentOutcome>((resolve) => {
        const cancel = () => this.cancel(id, 'refused')
        const request: PendingRequest = {
          ...prepared, submission, stdinValue,
          view: { id, operation: submission.operation, status: 'pending', expiresAt: new Date(expiresAt).toISOString(), caller, ...prepared.view },
          controller: new AbortController(),
          timer: setTimeout(() => this.cancel(id, 'expired'), expiresAt - Date.now()),
          finish: (outcome) => {
            clearTimeout(request.timer)
            request.stdinValue = undefined
            this.requests.delete(id)
            this.last = { ...request.view, status: outcome.status, error: outcome.error }
            signal?.removeEventListener('abort', cancel)
            this.services.changed()
            resolve(outcome)
          }
        }
        this.requests.set(id, request)
        signal?.addEventListener('abort', cancel, { once: true })
        this.services.changed()
        void this.services.review().catch(() => this.cancel(id, 'failed'))
      })
    } catch {
      return { requestId: id, status: 'failed', error: 'The request is invalid, expired, or its local references are unavailable.' }
    }
  }

  views(): AgentRequestView[] {
    return [...[...this.requests.values()].map(({ view }) => view), ...(this.last ? [this.last] : [])].map((view) => structuredClone(view))
  }

  async respond(input: unknown): Promise<void> {
    const response = z.strictObject({ id: z.uuid(), approved: z.boolean(), comparedCode: z.boolean().optional(),
      startedByMe: z.boolean().optional() }).safeParse(input)
    if (!response.success) throw new Error('Supply a request ID and a local approval decision.')
    const request = this.requests.get(response.data.id)
    if (!request || request.view.status !== 'pending') throw new Error('This request is no longer awaiting approval.')
    if (!response.data.approved) return this.cancel(response.data.id, 'refused')
    if (request.view.pairing && !response.data.comparedCode) throw new Error('Compare the pairing code on both devices before approval.')
    if (!request.view.caller.verified && !response.data.startedByMe) throw new Error('Confirm that you started this request before approval.')
    requireActive(request)
    clearTimeout(request.timer)
    request.view.status = 'running'
    this.services.changed()
    try {
      const result = await this.execute(request)
      if (!request.controller.signal.aborted) request.finish({ requestId: request.view.id, status: 'completed', result })
    } catch {
      if (!request.controller.signal.aborted) {
        request.finish({ requestId: request.view.id, status: Date.now() >= Date.parse(request.view.expiresAt) ? 'expired' : 'failed',
          error: 'The approved operation could not complete. Check the local project, vault, and storage.' })
      }
    }
  }

  cancelAll(): void {
    for (const id of this.requests.keys()) this.cancel(id, 'refused')
  }

  disconnect(): void {
    this.closed = true
    this.cancelAll()
  }

  private cancel(id: string, status: 'refused' | 'expired' | 'failed'): void {
    const request = this.requests.get(id)
    if (!request) return
    request.controller.abort()
    request.finish({ requestId: id, status, error: status === 'expired' ? 'The local request expired.' : 'The local request did not receive approval.' })
  }

  private async prepare(submission: AgentInput, stdinValue?: string) {
    if (submission.operation === 'project_setup') {
      const directory = await realpath(submission.input.directory ?? process.cwd())
      if (!(await stat(directory)).isDirectory()) throw new Error('Select an existing project folder.')
      const project = (await this.projects.list()).find((project) => project.directory === directory)
      if (!project && !isProjectName(submission.input.name)) throw new Error('A valid project name is required.')
      return { view: { project, secrets: [], detail: project ? `Read the registered project at ${directory}.` : `Register ${submission.input.name} at ${directory}.` } }
    }
    if (submission.operation === 'pair_device') {
      if (submission.input.action === 'export') {
        if (submission.input.path) throw new Error('Export accepts no input path.')
        if (process.platform !== 'darwin') throw new Error('Device-card sharing requires macOS. Use the relay to pair devices.')
        return { view: { secrets: [], detail: 'Send this device’s public device card to a nearby device.' } }
      }
      if (!submission.input.path) throw new Error('A device card path is required.')
      const preview = await (await this.services.sharing()).previewPeer(submission.input.path)
      return { pairingToken: preview.token, view: { secrets: [], detail: 'Verify the other device after comparing the pairing code.',
        pairing: { name: preview.device.name, fingerprint: preview.device.fingerprint, code: preview.code } } }
    }
    if (submission.operation === 'request_remote_demo') {
      const state = await this.services.relayState()
      const grant = state.sent.find((item) => item.messageId === submission.input.grantId && item.state === 'received')
      if (!grant) throw new Error('Select a relay transfer that the recipient imported.')
      const peer = state.peers.find((item) => item.identity === grant.recipient)?.name ?? grant.recipient.slice(0, 12)
      return { view: { secrets: [], detail: `Ask ${peer} to run the fixed environment demo with the secrets of relay transfer ${grant.messageId}. That device must also approve. The global.sct app sends the request. The result can arrive later.` } }
    }
    if (submission.operation === 'sharing_state' || submission.operation === 'relay_status') {
      return { view: { secrets: [], detail: submission.operation === 'sharing_state'
        ? 'Read this device, verified recipients, and pending transfer metadata.'
        : 'Read relay connection and cached delivery metadata. This can connect to the configured relay.' } }
    }
    const project = submission.input.projectId ? await this.projects.find(submission.input.projectId) : await resolveProject(this.projects)
    const secrets = await this.vault.listProjectSecrets(project.id)
    if (submission.operation === 'list_secrets') return { view: { project, secrets, detail: 'Read secret names and IDs in this project. Return no values.' } }
    const ids = submission.operation === 'send_secrets_to' ? submission.input.secretIds
      : submission.input.secretId ? [submission.input.secretId] : []
    const selectedIds = new Set(ids)
    const selectedSecrets = secrets.filter((secret) => selectedIds.has(secret.id))
    if (selectedIds.size !== ids.length || selectedSecrets.length !== ids.length) throw new Error('Invalid secret selection.')
    if (submission.operation === 'run_demo' && (ids.length === 1) === (stdinValue !== undefined)) throw new Error('Choose exactly one input source.')
    let detail: string
    if (submission.operation === 'send_secrets_to') {
      if (process.platform !== 'darwin') throw new Error('AirDrop sharing requires macOS. Use the relay to send secrets.')
      const recipient = (await (await this.services.sharing()).state()).peers.find((peer) => peer.id === submission.input.recipientId)
      if (!recipient) throw new Error('Verify the recipient first.')
      detail = `Encrypt the selected secrets for ${recipient.name} (${recipient.fingerprint}). Choose that device in the picker. Delivery remains unconfirmed.`
      const shareSummary: ShareSummary = { mode: 'airdrop', recipient: recipient.name, project: project.name,
        secretNames: selectedSecrets.map((secret) => secret.name) }
      return { view: { project, secrets: selectedSecrets, detail }, shareSummary }
    } else if (submission.operation === 'run_demo') {
      detail = `Run the fixed environment demo with ${stdinValue !== undefined ? 'a value from stdin' : 'the selected saved secret'}. The child can read its input. Return no process logs.`
    } else detail = submission.operation === 'delete_secret' ? 'Permanently delete this saved secret.' : 'Read this secret’s metadata. Return no value.'
    return { view: { project, secrets: selectedSecrets, detail } }
  }

  private async execute(request: PendingRequest): Promise<AgentResult> {
    const { submission, view } = request
    if (view.project) requireReviewedProject(request, await this.projects.find(view.project.id))
    requireActive(request)
    switch (submission.operation) {
      case 'project_setup':
        return view.project ?? this.vault.addProject({ name: submission.input.name, directory: await realpath(submission.input.directory ?? process.cwd()) })
      case 'list_secrets':
        return this.vault.listProjectSecrets(requireProject(request).id)
      case 'describe_secret': {
        const secret = (await this.vault.listProjectSecrets(requireProject(request).id)).find((secret) => secret.id === submission.input.secretId)
        if (!secret) throw new Error('The selected secret no longer exists.')
        return secret
      }
      case 'delete_secret':
        await this.vault.deleteSecret({ projectId: requireProject(request).id, id: submission.input.secretId })
        return { deleted: submission.input.secretId }
      case 'run_demo':
        return this.runDemo(request)
      case 'sharing_state':
        return (await this.services.sharing()).state()
      case 'pair_device': {
        const sharing = await this.services.sharing()
        requireActive(request)
        if (submission.input.action === 'verify') return sharing.confirmPeer(request.pairingToken)
        const path = await sharing.deviceCardFile()
        requireActive(request)
        await this.services.shareFile(path)
        return { path, status: 'public-device-card' }
      }
      case 'send_secrets_to': {
        if (!request.shareSummary) throw new Error('The share summary is unavailable.')
        return this.services.approveShare(request.shareSummary, async () => {
          const path = await (await this.services.sharing()).exportSecrets({ ...submission.input, projectId: requireProject(request).id })
          requireActive(request)
          await this.services.shareFile(path)
          return { path, recipientId: submission.input.recipientId, status: 'awaiting-transport' }
        })
      }
      case 'relay_status': {
        const state = await this.services.relayState()
        return { ...state, error: state.error ? 'The relay connection or local cache needs attention.' : null }
      }
      case 'request_remote_demo':
        return { taskId: await this.services.requestRemoteDemo(submission.input.grantId), status: 'queued' }
    }
  }

  private async runDemo(request: PendingRequest): Promise<AgentResult> {
    const launch = (project: Project, value: string) => {
      requireReviewedProject(request, project)
      requireExternalVault(project, this.vault.location())
      requireActive(request)
      return startFixedDemo(project, { SCT_DEMO_TOKEN: value }, this.services.executable, this.services.demo, request.controller.signal)
    }
    return demoOutcome(request.stdinValue !== undefined ? await launch(await this.projects.find(requireProject(request).id), request.stdinValue)
      : await this.vault.withSelectedSecrets(requireProject(request).id, request.view.secrets.map((secret) => secret.id),
        (project, secrets) => launch(project, secrets[0].value.toString('utf8'))))
  }
}

function requireSubmission(input: unknown): { submission: AgentInput; stdinValue?: string } {
  const envelope = z.strictObject({ operation: z.string(), input: z.unknown(),
    stdinValue: z.string().max(65536).refine((value) => !value.includes('\0')).optional() }).parse(input)
  if (!Object.hasOwn(agentTools, envelope.operation)) throw new Error('Unknown operation.')
  if (envelope.stdinValue !== undefined && envelope.operation !== 'run_demo') throw new Error('This operation accepts no secret input.')
  const operation = envelope.operation as AgentOperation
  return { submission: { operation, input: agentTools[operation].schema.parse(envelope.input) } as AgentInput, stdinValue: envelope.stdinValue }
}

function requireDeadline(input?: string): number {
  const deadline = input ? Date.parse(input) : Date.now() + 120_000
  if (deadline <= Date.now() || deadline > Date.now() + 300_000) throw new Error('Invalid local deadline.')
  return deadline
}

function requireActive(request: PendingRequest): void {
  if (request.controller.signal.aborted || Date.now() >= Date.parse(request.view.expiresAt)) throw new Error('The local request expired or disconnected.')
}

function requireProject(request: PendingRequest) {
  if (!request.view.project) throw new Error('The request has no registered project.')
  return request.view.project
}

function requireReviewedProject(request: PendingRequest, current: Project): void {
  const approved = requireProject(request)
  if (current.id !== approved.id || current.directory !== approved.directory || current.name !== approved.name) {
    throw new Error('The project changed after review.')
  }
}
