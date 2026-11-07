import type { DirectImportResult, DirectIncomingItem, DirectPeer, DirectPendingReceipt, DirectSentItem } from './direct'
import type { TransferReceipt } from './transport'
import type { WebRtcLinkPreview } from './connect'

export type WebRtcConnection = 'off' | 'connecting' | 'ready' | 'error'
export type WebRtcRoute = 'direct' | 'turn' | null

export interface WebRtcState {
  connection: WebRtcConnection
  peers: DirectPeer[]
  peerId: string | null
  offerLink: string | null
  answerLink: string | null
  route: WebRtcRoute
  incoming: DirectIncomingItem[]
  sent: DirectSentItem[]
  receipts: DirectPendingReceipt[]
  error: string | null
}

export interface WebRtcIceServer {
  urls: string[]
  username?: string
  credential?: string
}

export interface WebRtcSessionConfig {
  iceServers: WebRtcIceServer[]
  iceTransportPolicy: 'all' | 'relay'
}

// The visible window sees only non-secret settings. The TURN password stays in the vault and the hidden window.
export interface WebRtcIceConfig {
  stunUrl: string | null
  turnUrls: string[]
  turnUsername: string | null
  turnConfigured: boolean
  turnOnly: boolean
}

export interface WebRtcIceInput {
  stunUrl: string
  turnUrls: string[]
  turnUsername: string
  turnCredential: string
  turnOnly: boolean
}

export interface WebRtcSendInput {
  projectId: string
  secretIds: string[]
  recipientId: string
  accessExpiresAt: number | null
  injectionOnly: boolean
}

export interface WebRtcImportInput {
  transferId: string
  projectId: string
}

export interface WebRtcReceiptInput {
  transferId: string
  link: string
}

export interface WebRtcAPI {
  getWebRtcState: () => Promise<WebRtcState>
  getWebRtcIce: () => Promise<WebRtcIceConfig>
  saveWebRtcIce: (input: WebRtcIceInput) => Promise<WebRtcIceConfig>
  previewWebRtcLink: (link: string) => Promise<WebRtcLinkPreview>
  createWebRtcOffer: (peerId: string) => Promise<string>
  acceptWebRtcOffer: (link: string) => Promise<string>
  acceptWebRtcAnswer: (link: string) => Promise<void>
  closeWebRtc: () => Promise<void>
  sendWebRtc: (input: WebRtcSendInput) => Promise<void>
  importWebRtc: (input: WebRtcImportInput) => Promise<DirectImportResult>
  verifyWebRtcReceipt: (input: WebRtcReceiptInput) => Promise<TransferReceipt>
  onWebRtcChanged: (listener: () => void) => () => void
}
