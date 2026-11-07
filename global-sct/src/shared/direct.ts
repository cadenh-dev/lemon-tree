import type { SecretMetadata } from './secrets'
import type { TransferReceipt } from './transport'

export type DirectConnection = 'off' | 'starting' | 'ready' | 'error'
export type DirectDeliveryState = 'pending' | 'received' | 'manual' | 'expired' | 'failed'

export interface DirectPeer {
  id: string
  name: string
  fingerprint: string
  available: boolean
}

export interface DirectSentItem {
  transferId: string
  recipientId: string
  projectName: string
  secretNames: string[]
  createdAt: number
  deliverBy: number
  state: DirectDeliveryState
  receivedAt: number | null
  error: string | null
}

export interface DirectIncomingItem {
  transferId: string
  senderId: string
  senderName: string
  projectName: string
  secretNames: string[]
  deliverBy: number
  accessExpiresAt: number | null
  injectionOnly: boolean
  error: string | null
}

export interface DirectPendingReceipt {
  transferId: string
  senderName: string
  projectName: string
  receiptLink: string
}

export interface DirectState {
  connection: DirectConnection
  peers: DirectPeer[]
  incoming: DirectIncomingItem[]
  sent: DirectSentItem[]
  receipts: DirectPendingReceipt[]
  error: string | null
}

export interface DirectSendInput {
  projectId: string
  secretIds: string[]
  recipientId: string
  accessExpiresAt: number | null
  injectionOnly: boolean
}

export interface DirectImportInput {
  transferId: string
  projectId: string
}

export interface DirectImportResult {
  secrets: SecretMetadata[]
  receiptLink: string
  receiptSent: boolean
}

export interface DirectReceiptInput {
  transferId: string
  link: string
}

export interface DirectAPI {
  getDirectState: () => Promise<DirectState>
  sendDirect: (input: DirectSendInput) => Promise<void>
  importDirect: (input: DirectImportInput) => Promise<DirectImportResult>
  verifyDirectReceipt: (input: DirectReceiptInput) => Promise<TransferReceipt>
  onDirectChanged: (listener: () => void) => () => void
}
