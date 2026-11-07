// Relay responses carry metadata only. Payloads, wrapped keys, private keys, and relay tokens stay in the main process.

import type { SecretMetadata } from './secrets'
import type { RelayTaskOutcome } from './envelope'
import type { ReceiptState } from './transport'

// off: the relay is turned off. offline: the app waits for the next connection attempt.
export type RelayConnection = 'off' | 'connecting' | 'connected' | 'offline'

// unverified: the users did not compare the pairing code. verified: the saved keys match the relay keys.
// changed: the relay keys differ from the saved keys, so the users must compare the new code. invalid: the keys cannot be used.
export type RelayTrust = 'unverified' | 'verified' | 'changed' | 'invalid'

export interface RelayPeer {
  pairId: string
  identity: string
  name: string
  // The relay status. Only the device that did not send the request can set Verified.
  status: 'Pending' | 'Verified'
  requestedByMe: boolean
  // Both users compare this code before they confirm. It is null when the keys cannot be used.
  code: string | null
  trust: RelayTrust
}

export interface ConfirmRelayPairInput {
  pairId: string
  code: string
}

export interface RelayInboxItem {
  messageId: string
  sender: string
  createdAt: string
  deliverBy: string
  state: 'pending' | 'received' | 'failed'
  projectName: string | null
  secretNames: string[]
  accessExpiresAt: string | null
  injectionOnly: boolean | null
  destinationProjectId: string | null
  receivedAt: string | null
  error: string | null
}

export type RelayDeliveryState = 'queued' | 'sent' | 'received' | 'failed' | 'expired'

// The relay has no manual receipt. Link mode waits for a pasted receipt link.
export type RelayReceiptState = Exclude<ReceiptState, { state: 'manual' }>

export interface RelaySentItem {
  messageId: string
  recipient: string
  state: RelayDeliveryState
  createdAt: string | null
  deliverBy: string | null
  receivedAt: string | null
  accessExpiresAt: string | null
  accessExpiredAt: string | null
  error: string | null
  // The shared receipt contract (C8d). The main process sets this from the verified relay receipt.
  receiptState: RelayReceiptState
}

export interface RelayQueueInput {
  projectId: string
  secretIds: string[]
  recipient: string
  accessExpiresAt: number | null
  injectionOnly: boolean
}

// The main process sets the delivery deadline when it queues the transfer.
export interface RelayTransferInput extends RelayQueueInput {
  deliverBy: number
}

export interface RelayAcceptInput {
  messageId: string
  projectId: string
}

// Sent tasks: queued, sent, delivered, then the outcome from the result. A delivery receipt does not show approval or execution.
// Received tasks: awaiting-approval, running, then the outcome. An uncertain run needs local review before its result is sent.
export type RelayTaskState = 'queued' | 'sent' | 'delivered' | 'awaiting-approval' | 'running' | RelayTaskOutcome

export interface RelayTaskItem {
  messageId: string
  direction: 'sent' | 'received'
  // The other device: the recipient of a sent task, or the sender of a received task.
  peer: string
  grantId: string
  // Received tasks only. The local approval must supply this digest, so it applies to this exact task.
  digest: string | null
  // Received tasks only: the grant contents that the run injects.
  projectName: string | null
  secretNames: string[]
  createdAt: string
  approveBy: string
  state: RelayTaskState
  exitCode: number | null
  secretPresent: boolean | null
  finishedAt: string | null
  // Received tasks only: the delivery state of the encrypted result.
  reply: 'none' | RelayDeliveryState
  reviewRequired: boolean
  error: string | null
}

export interface RelayTaskDecision {
  messageId: string
  digest: string
  // report sends the uncertain outcome of an interrupted run. It cannot start the task again.
  decision: 'approve' | 'refuse' | 'report'
}

// A row of delivery activity: an inbox transfer, a sent transfer, or a task. The peer is the other device.
export interface RelayActivityKey {
  kind: 'inbox' | 'sent' | 'task'
  messageId: string
  peer: string
}

// The user can delete one finished row, or all rows. A deleted row stays in the local records, so duplicate checks,
// grants, and cleanup notices continue to work. A deleted row that changes state shows again.
export function relayInboxFinished(item: RelayInboxItem): boolean {
  return item.state !== 'pending'
}

export function relaySentFinished(item: RelaySentItem): boolean {
  return item.state === 'received' || item.state === 'failed' || item.state === 'expired'
}

export function relayTaskFinished(item: RelayTaskItem): boolean {
  return ['completed', 'refused', 'expired', 'failed', 'uncertain'].includes(item.state) && !item.reviewRequired
}

export interface RelayState {
  connection: RelayConnection
  // The relay identity of this device, as a hexadecimal string.
  identity: string | null
  registered: boolean
  error: string | null
  // The time of the last relay update in the cache. Rows are cached when the connection is not connected.
  updatedAt: string | null
  peers: RelayPeer[]
  inbox: RelayInboxItem[]
  sent: RelaySentItem[]
  tasks: RelayTaskItem[]
}

export interface RelayAPI {
  getRelayState: () => Promise<RelayState>
  onRelayChanged: (listener: () => void) => () => void
  // The identity is the relay ID of the other device, as 64 hexadecimal characters.
  requestRelayPair: (identity: string) => Promise<void>
  confirmRelayPair: (input: ConfirmRelayPairInput) => Promise<void>
  removeRelayPair: (pairId: string) => Promise<void>
  // Returns the message ID of the queued transfer.
  queueRelayTransfer: (input: RelayQueueInput) => Promise<string>
  acceptRelayTransfer: (input: RelayAcceptInput) => Promise<SecretMetadata[]>
  // The grant ID is the message ID of a received relay transfer to that device. Returns the message ID of the task.
  queueRelayTask: (grantId: string) => Promise<string>
  respondRelayTask: (input: RelayTaskDecision) => Promise<void>
  hideRelayActivity: (input: RelayActivityKey) => Promise<void>
  hideAllRelayActivity: () => Promise<void>
}
