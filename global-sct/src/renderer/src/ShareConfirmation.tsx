import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { ShareRequestView } from '../../shared/share'
import { errorText } from './operation'

// The main process holds the outgoing operation. This dialog can only release it with the vault passphrase.
export function ShareConfirmation() {
  const [request, setRequest] = useState<ShareRequestView | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const passphraseField = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let active = true
    const refresh = () => {
      window.sct.getShareRequest().then((value) => {
        if (active) setRequest(value)
      }).catch(() => {
        if (active) setRequest(null)
      })
    }
    const stop = window.sct.onShareChanged(refresh)
    refresh()
    return () => { active = false; stop() }
  }, [])

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (request && !element.open) {
      element.showModal()
      passphraseField.current?.focus()
    } else if (!request && element.open) {
      element.close()
    }
  }, [request])

  useEffect(() => {
    if (!request) {
      setPassphrase('')
      setError(null)
      setBusy(false)
    }
  }, [request])

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!request) return
    setBusy(true)
    setError(null)
    try {
      await window.sct.confirmShare({ id: request.id, passphrase })
      setPassphrase('')
    } catch (cause) {
      setError(errorText(cause, 'Cannot confirm the share.'))
    } finally {
      setBusy(false)
    }
  }

  async function cancel() {
    setBusy(true)
    try {
      await window.sct.cancelShare()
    } catch (cause) {
      setError(errorText(cause, 'Cannot cancel the share.'))
    } finally {
      setBusy(false)
    }
  }

  if (!request) return <dialog ref={dialog} className="import-dialog" aria-labelledby="share-confirm-heading" />
  return (
    <dialog ref={dialog} className="import-dialog" aria-labelledby="share-confirm-heading"
      onCancel={(event) => { event.preventDefault(); void cancel() }}>
      <h2 id="share-confirm-heading">Confirm this share</h2>
      <p>Sending <strong>{request.project}</strong> to <strong>{request.recipient}</strong> by {modeLabel(request.mode)}.</p>
      <p className="field-help">{request.secretNames.join(', ')}</p>
      <form onSubmit={(event) => { void confirm(event) }}>
        <fieldset disabled={busy}>
          <label htmlFor="share-passphrase">Vault passphrase</label>
          <input ref={passphraseField} id="share-passphrase" name="sharePassphrase" type="password" autoComplete="current-password"
            value={passphrase} onChange={(event) => setPassphrase(event.target.value)} required />
          <p className="field-help">The confirmation is valid for two minutes. It applies to this operation only.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="form-actions">
            <button type="button" className="secondary" disabled={busy} onClick={() => { void cancel() }}>Cancel share</button>
            <button type="submit" disabled={busy || !passphrase}>Confirm share</button>
          </div>
        </fieldset>
      </form>
    </dialog>
  )
}

function modeLabel(mode: ShareRequestView['mode']): string {
  if (mode === 'mailbox') return 'Mailbox'
  if (mode === 'webrtc') return 'WebRTC'
  if (mode === 'airdrop') return 'AirDrop'
  return mode === 'direct' ? 'Direct' : 'Link'
}
