import { z } from 'zod/v4'
import type { Project } from './projects'
import type { SecretMetadata } from './secrets'
import type { SharingDevice, SharingState } from './sharing'
import type { RelayState } from './relay'

const projectId = z.uuid().optional().describe('Registered project ID. Omit to select the nearest registered parent of the working directory.')
const expiresAt = z.iso.datetime({ offset: true }).optional().describe('Local approval deadline. Default: two minutes. Maximum: five minutes from submission.')

export const agentTools = {
  project_setup: {
    description: 'Find or register a local project folder after local approval. Return project metadata. Create no secret file in the project.',
    schema: z.strictObject({ name: z.string().min(1).max(80).optional(), directory: z.string().min(1).optional(), expiresAt })
  },
  list_secrets: {
    description: 'List secret IDs and environment names in one approved local project. Return metadata only.',
    schema: z.strictObject({ projectId, expiresAt })
  },
  describe_secret: {
    description: 'Describe one saved secret by project and secret ID after local approval. Return metadata without its value.',
    schema: z.strictObject({ projectId, secretId: z.uuid(), expiresAt })
  },
  delete_secret: {
    description: 'Delete one saved secret after explicit local approval. Return its ID without its value. The deletion cannot be undone.',
    schema: z.strictObject({ projectId, secretId: z.uuid(), expiresAt })
  },
  run_demo: {
    description: 'Request local approval to run the fixed environment demo with one saved secret. Return a fixed outcome without process logs. Reject arbitrary commands.',
    schema: z.strictObject({ projectId, secretId: z.uuid().optional(), expiresAt })
  },
  sharing_state: {
    description: 'Read this device, verified sharing recipients, and pending transfer metadata after local approval. Return no keys or secret values.',
    schema: z.strictObject({ expiresAt })
  },
  pair_device: {
    description: 'Export a public device card on macOS, or verify another device card through the local pairing screen. The user must compare the code on both devices.',
    schema: z.strictObject({ action: z.enum(['export', 'verify']), path: z.string().min(1).optional(), expiresAt })
  },
  send_secrets_to: {
    description: 'Encrypt selected secrets for a verified recipient on macOS after local approval. Open the AirDrop picker. This is unavailable on Windows and Linux; use the relay instead. This does not confirm delivery.',
    schema: z.strictObject({ projectId, secretIds: z.array(z.uuid()).min(1).max(1000), recipientId: z.string().min(1), expiresAt })
  },
  relay_status: {
    description: 'Read relay connection and cached peer, inbox, delivery, and remote task metadata after local approval. Cached rows do not prove current delivery. This does not pair or send.',
    schema: z.strictObject({ expiresAt })
  },
  request_remote_demo: {
    description: 'Ask the recipient of a received relay transfer to run the fixed environment demo with that grant, after local approval. The recipient must also approve on its device. The global.sct app sends the request. Read the outcome later with relay_status.',
    schema: z.strictObject({ grantId: z.uuid().describe('Message ID of a relay transfer that this device sent and the recipient imported.'), expiresAt })
  }
} as const

export type AgentOperation = keyof typeof agentTools
export type AgentInput = {
  [Operation in AgentOperation]: { operation: Operation; input: z.infer<(typeof agentTools)[Operation]['schema']> }
}[AgentOperation]

export type AgentResult = Project | SecretMetadata | SecretMetadata[] | SharingState | SharingDevice | RelayState
  | { deleted: string } | { exitCode: number; secretPresent: boolean }
  | { path: string; status: 'public-device-card' | 'awaiting-transport'; recipientId?: string }
  | { taskId: string; status: 'queued' }

export interface AgentOutcome {
  requestId: string
  status: 'completed' | 'refused' | 'expired' | 'failed'
  result?: AgentResult
  error?: string
}

export type AgentSubmit = (input: unknown, signal?: AbortSignal) => Promise<AgentOutcome>

export interface AgentCaller {
  name: string
  verified: boolean
}

export interface AgentResponse {
  id: string
  approved: boolean
  comparedCode?: boolean
  startedByMe?: boolean
}

export interface AgentRequestView {
  id: string
  operation: AgentOperation
  status: 'pending' | 'running' | AgentOutcome['status']
  expiresAt: string
  caller: AgentCaller
  project?: Project
  secrets: SecretMetadata[]
  detail: string
  pairing?: { name: string; fingerprint: string; code: string }
  error?: string
}

export interface AgentAPI {
  getAgentRequests: () => Promise<AgentRequestView[]>
  respondToAgent: (input: AgentResponse) => Promise<void>
  onAgentChanged: (listener: () => void) => () => void
}
