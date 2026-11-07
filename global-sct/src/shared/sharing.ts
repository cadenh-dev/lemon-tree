import type { SecretMetadata } from './secrets'
import type { LinkImportInput, LinkImportResult, LinkPreview, LinkReceiptInput, LinkRecord, LinkSendInput, LinkState, TransferReceipt } from './transport'

export const pairingLinkLimit = 16_384

export interface SharingDevice {
  id: string
  name: string
  fingerprint: string
}

export interface PairingPreview {
  token: string
  device: SharingDevice
  code: string
}

export interface TransferPreview {
  id: string
  sender: SharingDevice
  projectName: string
  secretNames: string[]
  expiresAt: string
}

export interface SharingState {
  device: SharingDevice
  peers: SharingDevice[]
  incoming: TransferPreview[]
}

export interface ShareSecretsInput {
  projectId: string
  secretIds: string[]
  recipientId: string
}

export interface ImportTransferInput {
  transferId: string
  projectId: string
}

export interface SharingAPI {
  createLink: (input: LinkSendInput) => Promise<LinkRecord>
  previewLink: (link: string) => Promise<LinkPreview>
  importLink: (input: LinkImportInput) => Promise<LinkImportResult>
  verifyLinkReceipt: (input: LinkReceiptInput) => Promise<TransferReceipt>
  getLinkState: () => Promise<LinkState>
  copyText: (text: string) => Promise<void>
  getSharingState: () => Promise<SharingState>
  shareDeviceCard: () => Promise<void>
  copyPairingLink: () => Promise<void>
  saveDeviceCard: () => Promise<boolean>
  previewPairingLink: (link: string) => Promise<PairingPreview>
  pickSharingPeer: () => Promise<PairingPreview | null>
  confirmSharingPeer: (token: string) => Promise<SharingDevice>
  shareSecrets: (input: ShareSecretsInput) => Promise<void>
  pickTransfer: () => Promise<TransferPreview | null>
  importTransfer: (input: ImportTransferInput) => Promise<SecretMetadata[]>
  dismissTransfer: (id: string) => Promise<void>
  onSharingChanged: (listener: () => void) => () => void
}
