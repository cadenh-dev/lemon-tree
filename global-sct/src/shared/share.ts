import type { DeliveryMode } from './transport'

// The transport that the user selected. WebRTC and AirDrop are paths within the shared delivery record.
export type ShareMode = DeliveryMode | 'webrtc' | 'airdrop'

// The main process takes this snapshot when an outgoing operation starts. The renderer cannot change it.
export interface ShareSummary {
  mode: ShareMode
  recipient: string
  project: string
  secretNames: string[]
}

// The active confirmation. The ID binds the dialog to the operation that the main process holds.
export interface ShareRequestView extends ShareSummary {
  id: string
  expiresAt: number
}

export interface ShareConfirmInput {
  id: string
  passphrase: string
}

export interface ShareAPI {
  // Returns the active confirmation, or null when no outgoing operation waits.
  getShareRequest: () => Promise<ShareRequestView | null>
  // Checks the passphrase and releases the operation that the main process already holds.
  confirmShare: (input: ShareConfirmInput) => Promise<void>
  cancelShare: () => Promise<void>
  onShareChanged: (listener: () => void) => () => void
}
