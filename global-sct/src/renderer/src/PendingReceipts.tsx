import type { DirectPendingReceipt } from '../../shared/direct'
import type { Run } from './types'

// A receipt that the peer did not receive in the same session. The user can copy the signed link and return it later.
export function PendingReceipts({ receipts, busy, run }: { receipts: DirectPendingReceipt[]; busy: boolean; run: Run }) {
  if (receipts.length === 0) return null
  return <section className="panel" aria-labelledby="pending-receipts-heading">
    <h2 id="pending-receipts-heading">Receipts to return</h2>
    <p>The session closed before the receipt was sent. Copy the link and send it to the sender.</p>
    <ul className="relay-peers" aria-label="Receipts to return">
      {receipts.map((item) => <li key={item.transferId}>
        <h3>{item.projectName}</h3>
        <p>From {item.senderName}</p>
        <label htmlFor={`pending-receipt-${item.transferId}`}>Receipt link</label>
        <textarea className="link-text" id={`pending-receipt-${item.transferId}`} value={item.receiptLink} readOnly spellCheck={false} />
        <div className="form-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => {
            void run('Copying the receipt link…', async () => {
              await window.sct.copyText(item.receiptLink)
              return 'Receipt link copied. Send it to the sender.'
            })
          }}>Copy receipt link</button>
        </div>
      </li>)}
    </ul>
  </section>
}
