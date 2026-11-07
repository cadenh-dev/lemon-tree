import type { RelayDeliveryState, RelayReceiptState } from '../shared/relay'
import type { TransferReceipt } from '../shared/transport'

// The relay keeps its own wire format and states. The main process maps them to the shared receipt contract (C8d).
// The caller supplies the verified receipt after it opens the relay receipt.
export function relayReceiptState(state: RelayDeliveryState, error: string | null,
  receipt: TransferReceipt | null): RelayReceiptState {
  if (state === 'received') {
    return receipt ? { state: 'received', receipt } : { state: 'failed', error: error ?? 'The receipt could not be verified.' }
  }
  if (state === 'failed') return { state: 'failed', error: error ?? 'The relay delivery failed.' }
  if (state === 'expired') return { state: 'expired' }
  return { state: 'pending' }
}
